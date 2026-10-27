"use client";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "./ui/button";
import { SignInLink } from "./sign-in-link";
import type { LiveMarket, LiveProvider } from "../lib/live-market";
import { sourceCohort } from "../../../packages/domain/src/source-credibility";
const rowsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      active: z.boolean(),
      syncState: z.string(),
      blobId: z.string().nullable(),
      payload: z.object({
        sourceName: z.string(),
        cohort: z.string(),
        kind: z.string(),
        version: z.number(),
        performance: z.object({
          events: z.number(),
          scored: z.number(),
          matched: z.number(),
          meanBrier: z.number().nullable(),
          pairedSamples: z.number(),
          pairedImprovement: z.number().nullable(),
        }),
      }),
    }),
  ),
});
export function SourceHistory({
  market,
  provider,
}: {
  market?: LiveMarket;
  provider?: LiveProvider;
}) {
  const [data, setData] = useState<z.infer<typeof rowsSchema>["data"]>([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [reload, setReload] = useState(0),
    [busy, setBusy] = useState(false);
  const [sourceName, setName] = useState(""),
    [reference, setReference] = useState(""),
    [outcome, setOutcome] = useState(""),
    [probability, setProbability] = useState(""),
    [consent, setConsent] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    void fetch("/api/sources", { signal: c.signal, cache: "no-store" })
      .then(async (r) => {
        if (!r.ok)
          throw new Error(
            r.status === 401
              ? "Sign in to follow sources."
              : "Source history is unavailable.",
          );
        const rows = rowsSchema.parse(await r.json()).data;
        if (!c.signal.aborted) {
          setData(rows);
          setError("");
        }
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(
            e instanceof Error ? e.message : "Source history unavailable.",
          );
      });
    return () => c.abort();
  }, [reload]);
  async function send(method: string, payload: unknown) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      const r = await fetch("/api/sources", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const b = await r.json();
        throw new Error(
          b.error === "EVENT_ALREADY_STARTED"
            ? "This event has started. New forecasts are closed."
            : b.error === "SOURCE_FORECAST_LOCKED"
              ? "This source already has a recorded forecast for this event."
              : r.status === 401
                ? "Sign in before saving a source."
                : "Could not save this source. Your entries are kept.",
        );
      }
      setNotice("Saved. Refresh after a moment to check Walrus storage.");
      setReload((v) => v + 1);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Request unavailable.");
    } finally {
      setBusy(false);
    }
  }
  const rows = market
    ? data.filter((r) => r.payload.cohort === sourceCohort(market))
    : data;
  return (
    <section className="panel source-history" aria-label="Source track records">
      <div className="row">
        <h2>Sources I follow</h2>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => setReload((v) => v + 1)}
        >
          Refresh
        </Button>
      </div>
      <p className="small muted">
        Remember what a source predicted, then check it against the final
        result. Thesis can use that history in your next conversation.
      </p>
      {error && (
        <p role="status">
          {error}{" "}
          {error.startsWith("Sign in") && <SignInLink>Sign in</SignInLink>}
        </p>
      )}
      {!error && !rows.length && <p>No source history yet.</p>}
      {rows.map((r) => (
        <article className="agent-suggestion" key={r.id}>
          <strong>{r.payload.sourceName}</strong>
          <p className="small">
            {r.payload.kind === "market_baseline"
              ? "Market quotes"
              : "Forecasts reported by you"}{" "}
            · {r.payload.cohort.replace(":", " · ")}
          </p>
          <p>
            {r.payload.performance.scored
              ? `${r.payload.performance.matched} matched out of ${r.payload.performance.scored} final results.`
              : "Waiting for verified final results."}{" "}
            {r.payload.performance.scored < 5 &&
              "Too early to judge reliability."}
          </p>
          {r.payload.performance.meanBrier !== null && (
            <details>
              <summary>How this is scored</summary>
              <p className="small">
                Brier score {r.payload.performance.meanBrier.toFixed(3)} (lower
                is better). Only forecasts recorded before a known event start
                count. Latest 50 recorded events; corrections replace earlier
                results. Compared with market quotes on{" "}
                {r.payload.performance.pairedSamples} shared events.
              </p>
            </details>
          )}
          <p className="small muted">
            {!r.active
              ? "Paused. Thesis will not use this history."
              : r.syncState === "done"
                ? "Verified in Walrus."
                : r.syncState === "processing"
                  ? "Saving to Walrus…"
                  : r.syncState === "retry"
                    ? "Walrus save will retry."
                    : "Waiting to save to Walrus."}
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void send("PATCH", {
                id: r.id,
                state: r.active ? "paused" : "active",
                confirmed: true,
              })
            }
          >
            {r.active ? "Pause source" : "Resume source"}
          </Button>
        </article>
      ))}
      {market && (
        <details>
          <summary>Remember a source for this event</summary>
          <p className="small">
            Save the current market quote, or record a forecast you saw
            elsewhere. External forecasts are labelled as reported by you; we do
            not verify who wrote them.
          </p>
          <label>
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />{" "}
            Save this source’s forecasts and results to my Walrus memory.
            Pausing stops future use; it does not erase existing blobs.
          </label>
          {!market.scheduledAt && (
            <p className="small">
              Event start is unconfirmed. This entry will stay unscored.
            </p>
          )}
          <Button
            disabled={busy || !consent}
            onClick={() =>
              void send("POST", {
                kind: "market_baseline",
                platform: market.platform,
                nativeId: market.id,
                provider: provider ?? "public",
                confirmed: true,
                memoryConsent: true,
              })
            }
          >
            Remember current market quote
          </Button>
          <details>
            <summary>Add another forecaster</summary>
            <label>
              Source name
              <input
                maxLength={160}
                value={sourceName}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Forecast link
              <input
                type="url"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="https://…"
              />
            </label>
            <label>
              Their prediction
              <select
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
              >
                <option value="">Choose outcome</option>
                {market.outcomes.map((o) => (
                  <option key={o.name} value={o.name}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Their stated chance (optional, %)
              <input
                type="number"
                min={0}
                max={100}
                value={probability}
                onChange={(e) => setProbability(e.target.value)}
              />
            </label>
            <Button
              disabled={
                busy ||
                !consent ||
                !sourceName.trim() ||
                !reference ||
                !outcome ||
                (probability !== "" &&
                  (!Number.isFinite(Number(probability)) ||
                    Number(probability) < 0 ||
                    Number(probability) > 100))
              }
              onClick={() =>
                void send("POST", {
                  kind: "user_reported_forecaster",
                  platform: market.platform,
                  nativeId: market.id,
                  provider: provider ?? "public",
                  confirmed: true,
                  memoryConsent: true,
                  sourceName,
                  reference,
                  outcome,
                  probability:
                    probability === "" ? null : Number(probability) / 100,
                })
              }
            >
              Record forecast
            </Button>
          </details>
        </details>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
