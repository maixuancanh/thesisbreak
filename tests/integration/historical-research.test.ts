import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { claimRun, finishRun } from "../../packages/db/src/agent-runs";
import { createChatSession } from "../../packages/db/src/chat-sessions";
import { readHistoricalResearchEvidence } from "../../packages/db/src/historical-research";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("historical original owner/time fences", () => {
  const p = new Pool({ connectionString: url }),
    u = randomUUID(),
    other = randomUUID();
  let cutoff: Date;
  beforeAll(async () => {
    for (const id of [u, other])
      await p.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
        id,
      ]);
    for (const [user, native, text, publishedAt] of [
      [u, "HISTORY", "Original eligible", "2020-01-01T00:00:00Z"],
      [other, "HISTORY", "FOREIGN SECRET", "2020-01-01T00:00:00Z"],
      [u, "OTHER", "OTHER EVENT SECRET", "2020-01-01T00:00:00Z"],
      [u, "HISTORY", "UNKNOWN PUBLICATION", null],
    ] as const) {
      const s = await createChatSession(p, user, true);
      const r = await claimRun(p, user, {
        sessionId: s.id,
        platform: "kalshi",
        nativeId: native,
        provider: "public",
        message: "Historical test",
        requestId: randomUUID(),
      });
      await finishRun(
        p,
        user,
        r.id,
        {
          reply: { message: "Record" },
          learningEvidence: [
            {
              id: "source",
              text,
              origin: "tool_result",
              publishedAt,
              retrievedAt: "2020-01-01T01:00:00Z",
              sourceOrigin: "official",
            },
          ],
        },
        "completed",
      );
    }
    cutoff = (await p.query("SELECT clock_timestamp() at")).rows[0].at;
  });
  afterAll(async () => {
    await p.query("DELETE FROM users WHERE id=ANY($1)", [[u, other]]);
    await p.end();
  });
  it("reads only original owner native published-known-by-cutoff records", async () => {
    const rows = await readHistoricalResearchEvidence(p, {
      userId: u,
      platform: "kalshi",
      nativeId: "HISTORY",
      cutoff,
    });
    expect(rows.filter((x) => !x.historicalOrigin).map((x) => x.text)).toEqual([
      "Original eligible",
    ]);
    expect(rows.some((x) => x.historicalOrigin === "user_statement")).toBe(
      true,
    );
    expect(JSON.stringify(rows)).not.toMatch(
      /FOREIGN SECRET|OTHER EVENT SECRET|UNKNOWN PUBLICATION/,
    );
    const beforeRecording = await readHistoricalResearchEvidence(p, {
      userId: u,
      platform: "kalshi",
      nativeId: "HISTORY",
      cutoff: new Date("2020-02-01T00:00:00Z"),
    });
    expect(beforeRecording).toEqual([]);
  });
});
