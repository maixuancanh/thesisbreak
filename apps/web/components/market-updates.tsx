"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { z } from "zod";
import { Button } from "./ui/button";
const responseSchema = z.object({
  monitors: z.array(
    z.object({
      id: z.string(),
      question: z.string().nullable(),
      state: z.string(),
      source_health: z.string(),
      deadline: z.string(),
      latest_decision: z
        .object({
          decision: z.enum(["wait", "review"]),
          reason: z.string(),
          checkedAt: z.string(),
        })
        .nullable()
        .optional(),
    }),
  ),
  updates: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      platform: z.string(),
      native_id: z.string(),
      created_at: z.string(),
      read_at: z.string().nullable(),
      evidence: z.unknown(),
    }),
  ),
});
const titles: Record<string, string> = {
  player_status_changed: "A player in your reason has a new status",
  market_resolved: "The final result is in",
  resolution_corrected: "The source corrected its final result",
  rules_changed: "Settlement rules changed — review the source",
  price_changed: "Market price changed",
  source_delayed: "Source update delayed",
  source_incomplete: "Source data is incomplete",
};
const resultEvidence = z.object({
  current: z.object({
    resolution: z.object({ outcome: z.string(), resolvedAt: z.string() }),
  }),
  assessment: z.object({
    pickVersion: z.number().int(),
    pickedOutcome: z.string(),
    result: z.enum(["matched", "did_not_match", "not_scored"]),
  }),
});
function ResultSummary({ evidence }: { evidence: unknown }) {
  const parsed = resultEvidence.safeParse(evidence);
  if (!parsed.success) return null;
  const { current, assessment } = parsed.data;
  return (
    <p>
      Source result: <strong>{current.resolution.outcome}</strong>. Your saved
      view: {assessment.pickedOutcome}.
      {assessment.result === "matched"
        ? " Your view matched the result."
        : assessment.result === "did_not_match"
          ? " Your view did not match the result."
          : " This entry does not have a verified pre-event record and final result, so it is not scored."}{" "}
      A matching result alone does not tell us whether the reasoning was sound.
    </p>
  );
}
function PlayerSummary({ evidence }: { evidence: unknown }) {
  const parsed = z
    .object({
      previous: z.object({ status: z.string() }),
      current: z.object({
        player: z.string(),
        status: z.string(),
        url: z.url(),
        text: z.string(),
      }),
    })
    .safeParse(evidence);
  if (!parsed.success) return null;
  const { previous, current } = parsed.data;
  return (
    <p>
      {current.player}: {previous.status} → {current.status}.{" "}
      <a href={current.url} target="_blank" rel="noreferrer">
        Read the official report
      </a>
      . Review how this affects your reason.
    </p>
  );
}
const watchLabels: Record<string, string> = {
  active: "Watching",
  paused: "Paused",
  expired: "Watch ended",
  superseded: "Pick changed — review a new watch",
};
const sourceLabels: Record<string, string> = {
  pending: "First check pending",
  available: "Source checked",
  source_delayed: "Source delayed",
  source_incomplete: "Source missing required data",
};
export function MarketUpdates() {
  const [data, setData] = useState<z.infer<typeof responseSchema> | null>(null),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    void fetch("/api/monitors", { cache: "no-store", signal: c.signal })
      .then(async (r) => {
        if (!r.ok)
          throw new Error(
            r.status === 401
              ? "Sign in to see watched events."
              : "Updates are unavailable.",
          );
        const parsed = responseSchema.parse(await r.json());
        if (!c.signal.aborted) {
          setData(parsed);
          setError("");
        }
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(e instanceof Error ? e.message : "Updates unavailable.");
      });
    return () => c.abort();
  }, [reload]);
  async function act(id: string, action: "read" | "paused") {
    const r = await fetch("/api/monitors", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action, confirmed: true }),
    });
    if (r.ok) setReload((x) => x + 1);
    else setError("Could not update this watch. Please refresh.");
  }
  return (
    <section className="panel">
      <div className="row">
        <h2>Watching & updates</h2>
        <Button variant="outline" onClick={() => setReload((x) => x + 1)}>
          Check updates
        </Button>
      </div>
      <p className="small muted">
        Follow changes in your markets and relevant official reports. Your pick
        changes only after you review and confirm it.
      </p>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          {!data.monitors.length && (
            <p>No watched picks yet. Start a watch from My picks.</p>
          )}
          {data.monitors.map((m) => (
            <div key={m.id}>
              <p>
                {m.question ?? "Saved market"} ·{" "}
                {watchLabels[m.state] ?? "Status unavailable"} ·{" "}
                {sourceLabels[m.source_health] ?? "Source status unavailable"}
              </p>
              <p className="small muted">
                Until {new Date(m.deadline).toLocaleString()}
              </p>
              {m.latest_decision && (
                <p className="small">
                  {m.latest_decision.reason === "incomplete_coverage"
                    ? "Waiting for a complete source check. Your pick stays as saved."
                    : m.latest_decision.decision === "review"
                      ? "Something changed in the market. Take another look before changing your pick."
                      : "No new market change in this check."}{" "}
                  Checked{" "}
                  {new Date(m.latest_decision.checkedAt).toLocaleTimeString()}.
                </p>
              )}
              {m.state === "active" && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void act(m.id, "paused")}
                >
                  Pause watch
                </Button>
              )}
            </div>
          ))}
          {data.updates.map((u) => (
            <article className="agent-suggestion" key={u.id}>
              <h3>{titles[u.kind] ?? "Market update"}</h3>
              <ResultSummary evidence={u.evidence} />
              {u.kind === "player_status_changed" && (
                <PlayerSummary evidence={u.evidence} />
              )}
              <p className="small muted">
                {new Date(u.created_at).toLocaleString()} ·{" "}
                {u.read_at ? "Read" : "New"}
              </p>
              <Link
                href={`/live-market/${u.platform}/${encodeURIComponent(u.native_id)}`}
              >
                {u.kind === "market_resolved" ||
                u.kind === "resolution_corrected"
                  ? "Review result & reasoning with Thesis"
                  : "Review market with Thesis"}
              </Link>
              {!u.read_at && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void act(u.id, "read")}
                >
                  Mark read
                </Button>
              )}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
