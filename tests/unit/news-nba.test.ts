import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { fetchNbaReport } from "../../packages/integrations/src/news/nba";
import {
  nbaTarget,
  selectEvidence,
} from "../../packages/integrations/src/news/mapping";

const pdfUrl =
  "https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-10-25_12_30PM.pdf";
describe("official NBA injury reports", () => {
  it("extracts date, team and player/status across continuation rows and pages", async () => {
    const bytes = await readFile(
      new URL("../fixtures/news/nba-official-2026-10-25.pdf", import.meta.url),
    );
    const calls: string[] = [];
    const transport = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push(String(url));
      expect(init?.redirect).toBe("error");
      return calls.length === 1
        ? new Response(
            `<a href="${pdfUrl.replace("12_30PM", "01_00AM")}">old</a><a href="${pdfUrl}">latest</a>`,
          )
        : new Response(bytes);
    }) as typeof fetch;
    const result = await fetchNbaReport({
      transport,
      now: new Date("2026-10-25T18:00:00Z"),
    });
    expect(result.state).toBe("available");
    expect(result.items).toHaveLength(42);
    expect(calls[1]).toBe(pdfUrl);
    expect(result.items).toContainEqual(
      expect.objectContaining({
        player: "Carr, Cameron",
        status: "Out",
        teams: ["Los Angeles Lakers", "Utah Jazz"],
        eventDate: "2026-10-25",
      }),
    );
    expect(result.items).toContainEqual(
      expect.objectContaining({
        player: "Ingram, Brandon",
        teams: ["LA Clippers", "Oklahoma City Thunder"],
        eventDate: "2026-10-25",
      }),
    );
    expect(
      result.items.find((item) => item.player === "Beal, Bradley")?.text,
    ).toContain("Management");
    expect(result.items.some((item) => item.player?.includes("NOT YET"))).toBe(
      false,
    );
    expect(result.items.every((item) => item.teams.length === 2)).toBe(true);
    const target = nbaTarget({
      platform: "kalshi",
      nativeId: "KXNBAGAME-26OCT25LALUTA-LAL",
    });
    expect(target).not.toBeNull();
    const matching = selectEvidence(result.items, target!);
    expect(matching).toHaveLength(7);
    expect(
      matching.find((item) => item.player === "Carr, Cameron")?.title,
    ).toContain("Los Angeles Lakers");
    expect(
      matching.find((item) => item.player === "Alexander, Trey")?.text,
    ).toContain("Utah Jazz");
    expect(matching.some((item) => item.player === "Ingram, Brandon")).toBe(
      false,
    );
  }, 20000);
  it("rejects off-host and malformed report links without fetching them", async () => {
    let calls = 0;
    const transport = (async () => {
      calls++;
      return new Response(
        '<a href="https://evil.example/Injury-Report_2026-10-25_12_30PM.pdf">report</a>',
      );
    }) as typeof fetch;
    expect((await fetchNbaReport({ transport })).state).toBe("invalid");
    expect(calls).toBe(1);
  });
  it("reports unavailable on transport failure and invalid on corrupt PDF", async () => {
    expect(
      (
        await fetchNbaReport({
          transport: (async () => {
            throw new Error("offline");
          }) as typeof fetch,
        })
      ).state,
    ).toBe("unavailable");
    let calls = 0;
    const transport = (async () =>
      new Response(
        ++calls === 1 ? `<a href="${pdfUrl}">report</a>` : "not PDF",
      )) as typeof fetch;
    expect((await fetchNbaReport({ transport })).state).toBe("invalid");
  });
  it("bounds the downloaded PDF and stops on failed HTTP responses", async () => {
    let calls = 0;
    const transport = (async () =>
      ++calls === 1
        ? new Response(`<a href="${pdfUrl}">report</a>`)
        : new Response("%PDF-", {
            headers: { "content-length": "5242881" },
          })) as typeof fetch;
    expect((await fetchNbaReport({ transport })).state).toBe("unavailable");
    expect(
      (
        await fetchNbaReport({
          transport: (async () =>
            new Response("blocked", { status: 403 })) as typeof fetch,
        })
      ).state,
    ).toBe("unavailable");
  });
});
