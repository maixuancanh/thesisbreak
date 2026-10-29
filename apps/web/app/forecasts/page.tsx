"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
type Row = {
  id: string;
  capturedAt: string;
  forecast: {
    homeTeam: string;
    awayTeam: string;
    horizon: string;
    probability: number | null;
    abstentionReason: string | null;
    scheduledAt: string;
    evidence: { url: string }[];
  };
  grade: { comparison: string; brier: number | null };
  receipt: { blobId: string } | null;
};
type Data = {
  rows: Row[];
  cohorts: {
    key: string;
    metrics: {
      eligibleEvents: number;
      coverage: number;
      brier: number | null;
      logLoss: number | null;
    };
  }[];
};
export default function Page() {
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    fetch("/api/forecasts")
      .then(async (r) => {
        if (!r.ok)
          throw Error(
            r.status === 401
              ? "Sign in to see your forecast history."
              : "Forecast history is temporarily unavailable.",
          );
        return r.json() as Promise<Data>;
      })
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <main style={{ maxWidth: 1000, margin: "48px auto", padding: "0 24px" }}>
      <Link href="/">← Markets</Link>
      <h1>Forecast history</h1>
      <p>
        See what Thesis expected before each game, what happened, and how well
        the probabilities held up.
      </p>
      <p>
        These forecasts are under evaluation. Improved accuracy has not been
        demonstrated.
      </p>
      {error ? (
        <p role="alert">
          {error} <Link href="/account">Account</Link>
        </p>
      ) : !data ? (
        <p role="status">Loading your forecasts…</p>
      ) : (
        <>
          {data.cohorts.map((c) => (
            <section key={c.key}>
              <h2>{c.key}</h2>
              <p>
                {c.metrics.eligibleEvents} settled games · Coverage{" "}
                {Math.round(c.metrics.coverage * 100)}% · Brier{" "}
                {c.metrics.brier?.toFixed(3) ?? "Awaiting results"}
              </p>
            </section>
          ))}
          {!data.rows.length && (
            <p>
              No forecasts recorded yet. Forecasts appear only when captured
              before a game at a scheduled checkpoint.
            </p>
          )}
          {data.rows.map((r) => (
            <article
              key={r.id}
              style={{ borderTop: "1px solid #ddd", padding: "24px 0" }}
            >
              <h2>
                {r.forecast.homeTeam} vs {r.forecast.awayTeam}
              </h2>
              <p>
                {r.forecast.horizon === "T24h"
                  ? "24 hours before tip-off"
                  : "60 minutes before tip-off"}{" "}
                · {new Date(r.capturedAt).toLocaleString()}
              </p>
              <p>
                {r.forecast.probability === null
                  ? `Waiting: ${r.forecast.abstentionReason}`
                  : `${r.forecast.homeTeam}: ${Math.round(r.forecast.probability * 100)}%`}
              </p>
              <p>
                {r.grade.comparison === "not_scored"
                  ? "Awaiting a confirmed result"
                  : r.grade.comparison === "matched"
                    ? "Outcome matched"
                    : "Outcome differed"}{" "}
                · Brier {r.grade.brier?.toFixed(3) ?? "—"}
              </p>
              <details>
                <summary>Sources and memory</summary>
                {r.forecast.evidence.map((e, i) => (
                  <p key={i}>
                    <a href={e.url} target="_blank" rel="noreferrer">
                      Evidence {i + 1}
                    </a>
                  </p>
                ))}
                <p>
                  {r.receipt
                    ? `Verified Walrus memory: ${r.receipt.blobId}`
                    : "Memory not yet verified"}
                </p>
              </details>
            </article>
          ))}
        </>
      )}
    </main>
  );
}
