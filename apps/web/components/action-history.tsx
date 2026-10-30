"use client";
import { useEffect, useState } from "react";
import { z } from "zod";
const schema = z.object({
  memoryConsent: z.boolean(),
  data: z.array(
    z.object({
      proposalId: z.string(),
      nativeId: z.string(),
      confirmedAt: z.string(),
      before: z.object({ outcome: z.string(), reason: z.string() }),
      after: z.object({ outcome: z.string(), reason: z.string() }),
      status: z.string(),
      beforeMatched: z.boolean().nullable(),
      afterMatched: z.boolean().nullable(),
      sourceUrl: z.string().nullable(),
    }),
  ),
});
export function ActionHistory() {
  const [state, setState] = useState<z.infer<typeof schema> | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    void fetch("/api/review/actions", { signal: c.signal, cache: "no-store" })
      .then(async (r) => {
        if (!r.ok)
          throw Error(
            r.status === 401
              ? "Sign in to see your confirmed decisions."
              : "Decision history is unavailable.",
          );
        return schema.parse(await r.json());
      })
      .then((value) => {
        if (!c.signal.aborted) setState(value);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, []);
  return (
    <section className="panel confirmed-decisions">
      <h2>Decisions you confirmed</h2>
      <p>
        See what changed and how the event turned out. A better outcome does not
        prove the advice caused it. Automatic result checks currently cover
        Kalshi; other markets remain unscored.
      </p>
      {error && <p role="status">{error}</p>}
      {state && (
        <>
          <label>
            <input
              type="checkbox"
              checked={state.memoryConsent}
              disabled={busy}
              onChange={async (e) => {
                const value = e.target.checked;
                setBusy(true);
                try {
                  const r = await fetch("/api/review/actions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      memoryConsent: value,
                      confirmed: true,
                    }),
                  });
                  if (!r.ok) throw Error("Could not update memory choice.");
                  setState({ ...state, memoryConsent: value });
                  setError("");
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Could not save.");
                } finally {
                  setBusy(false);
                }
              }}
            />
            Let Thesis remember my confirmed decisions and results in Walrus
          </label>
          <p className="small">
            Turning this off stops future use and writes. Existing blobs are not
            erased.
          </p>
          {!state.data.length && (
            <p>
              No confirmed changes yet. Drafts and suggestions do not count.
            </p>
          )}
          {state.data.map((a) => (
            <article key={a.proposalId}>
              <strong>{a.nativeId}</strong>
              <p>
                {a.before.outcome} → {a.after.outcome}
              </p>
              <p>{a.after.reason}</p>
              <p>
                {a.status === "observed_final"
                  ? `Before: ${a.beforeMatched ? "matched" : "did not match"} the result. After: ${a.afterMatched ? "matched" : "did not match"} the result.`
                  : "Waiting for a verified result, or missing event timing."}
              </p>
              {a.sourceUrl && (
                <a href={a.sourceUrl} target="_blank" rel="noreferrer">
                  Result reference ↗
                </a>
              )}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
