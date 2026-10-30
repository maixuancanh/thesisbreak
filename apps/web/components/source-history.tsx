"use client";
import { useEffect, useState } from "react";
import { SourceFactReview } from "./source-fact-review";
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
        factReviews: z
          .array(
            z.object({ verdict: z.enum(["supported", "refuted", "unclear"]) }),
          )
          .optional(),
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
  const [mode, setMode] = useState<"market" | "person">("market");
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
      setNotice("Saved. Thesis can use this history in future conversations.");
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
    <section
      className="panel source-history"
      aria-label="Prediction track records"
    >
      <div className="row">
        <h2>Who gets it right?</h2>
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
        Keep track of predictions. See how they turn out, and give Thesis more
        context next time.
      </p>
      {error && (
        <p role="status">
          {error}{" "}
          {error.startsWith("Sign in") && <SignInLink>Sign in</SignInLink>}
        </p>
      )}
      {!error && !rows.length && (
        <p className="source-empty">
          No predictions tracked yet. Start with the market odds or someone you
          follow.
        </p>
      )}
      {rows.map((r) => (
        <article className="agent-suggestion" key={r.id}>
          <strong>{r.payload.sourceName}</strong>
          {r.active && (
            <SourceFactReview
              profileId={r.id}
              onSaved={() => setReload((v) => v + 1)}
            />
          )}
          <p className="small">
            {r.payload.kind === "market_baseline"
              ? "Market quotes"
              : "Added by you"}{" "}
          </p>
          <p>
            {r.payload.performance.scored
              ? `${r.payload.performance.matched} correct out of ${r.payload.performance.scored} completed events.`
              : "Waiting for results."}{" "}
            {r.payload.performance.scored < 5 &&
              "Still building a track record."}
          </p>
          {!!r.payload.factReviews?.length && (
            <p className="small">
              Your fact checks:{" "}
              {
                r.payload.factReviews.filter((x) => x.verdict === "supported")
                  .length
              }{" "}
              supported,{" "}
              {
                r.payload.factReviews.filter((x) => x.verdict === "refuted")
                  .length
              }{" "}
              refuted,{" "}
              {
                r.payload.factReviews.filter((x) => x.verdict === "unclear")
                  .length
              }{" "}
              unclear. These are your assessments, not independent verification.
            </p>
          )}
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
                ? "Memory saved."
                : r.syncState === "processing"
                  ? "Saving memory…"
                  : r.syncState === "retry"
                    ? "Memory save is delayed. We’ll try again."
                    : "Memory save queued."}
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
        <details className="source-add">
          <summary>
            Track a prediction <span aria-hidden="true">＋</span>
          </summary>
          <div className="source-add-body">
            <div
              className="source-mode"
              role="group"
              aria-label="Prediction to track"
            >
              <Button
                variant="ghost"
                aria-pressed={mode === "market"}
                onClick={() => setMode("market")}
              >
                Market odds
              </Button>
              <Button
                variant="ghost"
                aria-pressed={mode === "person"}
                onClick={() => setMode("person")}
              >
                Someone I follow
              </Button>
            </div>
            {mode === "market" ? (
              <div className="source-market-preview">
                <p>Save today’s odds</p>
                <strong>{market.conditionLabel || market.question}</strong>
                <div className="source-quote-options">
                  {market.outcomes.map((o) => (
                    <span key={o.name}>
                      {o.name}{" "}
                      <b>
                        {o.price === null
                          ? "Unavailable"
                          : `${Math.round(o.price * 100)}%`}
                      </b>
                    </span>
                  ))}
                </div>
                <p className="small muted">
                  Thesis will compare this prediction with the final result.
                </p>
              </div>
            ) : (
              <div className="source-fields">
                <label>
                  Who made the prediction?
                  <input
                    maxLength={160}
                    value={sourceName}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="An analyst, newsletter or friend"
                  />
                </label>
                <label>
                  Link to their prediction
                  <input
                    type="url"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="Paste the post or article link"
                  />
                </label>
                <label>
                  What did they predict?
                  <select
                    value={outcome}
                    onChange={(e) => setOutcome(e.target.value)}
                  >
                    <option value="">Choose a result</option>
                    {market.outcomes.map((o) => (
                      <option key={o.name} value={o.name}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </label>
                <details className="source-confidence">
                  <summary>They gave a percentage?</summary>
                  <label>
                    Their chance of this result (%)
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={probability}
                      onChange={(e) => setProbability(e.target.value)}
                      placeholder="e.g. 70"
                    />
                  </label>
                </details>
                <p className="small muted">
                  Added by you. Thesis doesn’t verify who wrote the prediction.
                </p>
              </div>
            )}
            {!market.scheduledAt && (
              <p className="small muted">
                We don’t have a confirmed start time, so this prediction won’t
                count toward their track record yet.
              </p>
            )}
            <label className="source-consent">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>
                Let Thesis remember this prediction and its result for future
                conversations.
              </span>
            </label>
            <Button
              disabled={
                busy ||
                !consent ||
                (mode === "person" &&
                  (!sourceName.trim() ||
                    !reference ||
                    !outcome ||
                    (probability !== "" &&
                      (!Number.isFinite(Number(probability)) ||
                        Number(probability) < 0 ||
                        Number(probability) > 100))))
              }
              onClick={() =>
                void send("POST", {
                  kind:
                    mode === "market"
                      ? "market_baseline"
                      : "user_reported_forecaster",
                  platform: market.platform,
                  nativeId: market.id,
                  provider: provider ?? "public",
                  confirmed: true,
                  memoryConsent: true,
                  ...(mode === "person"
                    ? {
                        sourceName,
                        reference,
                        outcome,
                        probability:
                          probability === "" ? null : Number(probability) / 100,
                      }
                    : {}),
                })
              }
            >
              {busy
                ? "Saving…"
                : mode === "market"
                  ? "Track these odds"
                  : "Track this prediction"}
            </Button>
            <details className="source-memory-info">
              <summary>How memory works</summary>
              <p className="small muted">
                Your approved predictions and results are stored with Walrus
                Memory. You can pause a source to stop Thesis using its history.
                Pausing does not delete data already stored on Walrus.
              </p>
            </details>
          </div>
        </details>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
