"use client";
import { useState } from "react";
import { z } from "zod";
import { Button } from "./ui/button";
const schema = z.object({
  data: z.array(
    z.object({
      source: z.string(),
      state: z.string(),
      background: z.boolean(),
      checkedAt: z.string(),
      items: z.array(
        z.object({
          id: z.string(),
          url: z.url(),
          title: z.string(),
          text: z.string(),
          publishedAt: z.string().nullable(),
          retrievedAt: z.string(),
          eventDate: z.string().nullable(),
        }),
      ),
    }),
  ),
});
const labels: Record<string, string> = {
  available: "Source available",
  unavailable: "Could not reach source",
  invalid: "Source format not supported",
  unconfigured: "Optional source is not connected",
  access_required: "This feed needs provider access",
  rate_limited: "Source is busy — try later",
  partial: "Some data could not be loaded",
  unmapped: "No verified NBA game match",
};
export function IndependentEvidence({
  platform,
  nativeId,
  provider,
}: {
  platform: string;
  nativeId: string;
  provider: string;
}) {
  const [data, setData] = useState<z.infer<typeof schema>["data"] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(
        `/api/evidence?${new URLSearchParams({ platform, id: nativeId, provider })}`,
        { cache: "no-store" },
      );
      if (!r.ok)
        throw Error(
          r.status === 401
            ? "Sign in to check independent sources."
            : "Sources could not be checked. Please retry.",
        );
      const parsed = schema.safeParse(await r.json());
      if (!parsed.success)
        throw Error(
          "This source returned an unsupported response. Please retry later.",
        );
      setData(parsed.data.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sources unavailable.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="agent-evidence">
      <summary>Independent sources</summary>
      <p className="small muted">
        Official reports and announcements, separate from market prices. An
        injury report does not confirm a starting lineup.
      </p>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void load()}
      >
        {busy
          ? "Checking sources…"
          : data
            ? "Refresh sources"
            : "Check sources"}
      </Button>
      {error && <p role="alert">{error}</p>}
      {data?.map((c) => (
        <section key={c.source}>
          <h4>
            {c.source.startsWith("team-official:")
              ? `${c.source.split(":")[1]} official news`
              : c.source === "nba-official"
                ? "NBA injury report"
                : c.source === "fed-official"
                  ? "Federal Reserve releases"
                  : c.source === "balldontlie"
                    ? "BALLDONTLIE NBA data"
                    : "Event match"}
          </h4>
          <p className="small">
            {labels[c.state] ?? "Status unavailable"}
            {c.background
              ? " · Background context; not confirmed for this event"
              : ""}
          </p>
          {c.state === "available" && !c.items.length && (
            <p className="small muted">
              No matching records were returned. This does not confirm player
              availability.
            </p>
          )}
          {c.items.slice(0, 6).map((i) => (
            <article key={i.id}>
              <a href={i.url} target="_blank" rel="noreferrer">
                {i.title}
              </a>
              <p className="small">{i.text.slice(0, 500)}</p>
              <p className="small muted">
                {i.publishedAt
                  ? `Published ${new Date(i.publishedAt).toLocaleString()}`
                  : "Publication time unavailable"}{" "}
                · Retrieved {new Date(i.retrievedAt).toLocaleString()}
              </p>
            </article>
          ))}
        </section>
      ))}
    </details>
  );
}
