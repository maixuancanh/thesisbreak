"use client";
import { useEffect, useState } from "react";
import { PagedList } from "../../components/paged-list";
import { Button } from "../../components/ui/button";
import Link from "next/link";
import { ForecastScorecard } from "../../components/forecast-scorecard";
import type { ForecastScorecard as Scorecard } from "../../../../packages/domain/src/forecast-scorecard";
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
  scorecards: Scorecard[];
  subscription: {
    enabled: boolean;
    memory_consent: boolean;
    challenger_consent?: boolean;
  };
  rows: Row[];
  changes: {
    forecastId: string;
    percentagePointChange: number | null;
    summary: string;
  }[];
  cohorts: {
    key: string;
    shadow?: { status: string; candidateEvents: number };
    metrics: {
      eligibleEvents: number;
      coverage: number;
      brier: number | null;
      logLoss: number | null;
    };
  }[];
};
export default function Page() {
  const [view, setView] = useState<"History" | "Performance" | "Settings">(
    "History",
  );
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null),
    [verifying, setVerifying] = useState(false);
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
  async function subscribe(
    enabled: boolean,
    challengerConsent = data?.subscription.challenger_consent ?? false,
  ) {
    const response = await fetch("/api/forecasts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled,
        memoryConsent: enabled,
        challengerConsent,
      }),
    });
    if (!response.ok) {
      setError("Could not update tracking. Please try again.");
      return;
    }
    if (data)
      setData({
        ...data,
        subscription: {
          enabled,
          memory_consent: enabled,
          challenger_consent: enabled && challengerConsent,
        },
      });
  }
  async function verifyMemory() {
    setVerifying(true);
    setRecovery(null);
    try {
      const response = await fetch("/api/forecasts/recovery", {
        method: "POST",
      });
      if (!response.ok) throw Error();
      const report = await response.json();
      setRecovery(
        report.expectedRecords === 0
          ? "No verified forecast memories yet."
          : report.truncated
            ? "Checked a partial inventory. More memories remain."
            : `${report.expectedRecords} expected memory versions checked: ${report.completeness.replaceAll("_", " ")}.`,
      );
    } catch {
      setRecovery(
        "Memory verification is temporarily unavailable. Please try again.",
      );
    } finally {
      setVerifying(false);
    }
  }
  return (
    <main id="main" className="page forecast-library">
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
          <nav className="memory-filters" aria-label="Forecast sections">
            {(["History", "Performance", "Settings"] as const).map((tab) => (
              <Button
                key={tab}
                variant={view === tab ? "default" : "ghost"}
                aria-pressed={view === tab}
                onClick={() => setView(tab)}
              >
                {tab}
              </Button>
            ))}
          </nav>
          <div hidden={view !== "Settings"} className="workspace-stack">
            <section className="panel">
              <h2>Follow upcoming NBA games</h2>
              <p>
                Record a checkpoint 24 hours and 60 minutes before tip-off. Base
                Elo uses observed team results and does not adjust for player
                availability. Missing history produces a waiting checkpoint.
                Lineup-dependent research waits for official confirmation.
                Enabling tracking also saves these checkpoints to your Walrus
                memory. Stopping tracking affects future captures; existing
                memories remain.
              </p>
              <Button onClick={() => subscribe(!data.subscription.enabled)}>
                {data.subscription.enabled
                  ? "Stop tracking"
                  : "Enable tracking and memory"}
              </Button>
            </section>
            {data.subscription.enabled && (
              <section className="panel">
                <h2>Compare an AI research forecast</h2>
                <p>
                  Allow Thesis to send frozen event evidence to the configured
                  AI provider for a separate research forecast. It stays in
                  evaluation and never changes your pick. You can stop future
                  runs at any time.
                </p>
                <Button
                  onClick={() =>
                    subscribe(true, !data.subscription.challenger_consent)
                  }
                >
                  {data.subscription.challenger_consent
                    ? "Stop AI research forecasts"
                    : "Allow AI research forecasts"}
                </Button>
              </section>
            )}
            <section className="panel">
              <Button disabled={verifying} onClick={verifyMemory}>
                {verifying ? "Checking memory…" : "Verify my forecast memories"}
              </Button>
              {recovery && <p role="status">{recovery}</p>}
            </section>
          </div>
          {view === "Performance" && (
            <div className="workspace-stack">
              {data.scorecards?.map((card) => (
                <ForecastScorecard
                  key={`${card.methodVersion}/${card.horizon}`}
                  card={card}
                />
              ))}
              {data.cohorts.map((c) => (
                <details key={c.key}>
                  <summary>Calibration trial · {c.key}</summary>
                  {c.shadow && (
                    <p>
                      Calibration trial: {c.shadow.candidateEvents} forecasts
                      tested on later games.{" "}
                      {c.shadow.status === "review_candidate"
                        ? "Ready for independent review; the saved method is unchanged."
                        : "Still collecting evidence; the saved method is unchanged."}
                    </p>
                  )}
                </details>
              ))}
            </div>
          )}
          {view === "History" && (
            <>
              {!data.rows.length && (
                <p>
                  No forecasts recorded yet. Forecasts appear only when captured
                  before a game at a scheduled checkpoint.
                </p>
              )}
              <PagedList items={data.rows} label="Forecast pages">
                {(r) => (
                  <article key={r.id} className="panel forecast-record">
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
                    {data.changes
                      ?.filter((c) => c.forecastId === r.id)
                      .map((c) => (
                        <aside key={c.forecastId}>
                          <strong>Since the previous checkpoint</strong>
                          <p>
                            {c.percentagePointChange === null
                              ? c.summary
                              : `${c.percentagePointChange >= 0 ? "+" : ""}${c.percentagePointChange.toFixed(1)} percentage points. ${c.summary}`}
                          </p>
                        </aside>
                      ))}
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
                )}
              </PagedList>
            </>
          )}
        </>
      )}
    </main>
  );
}
