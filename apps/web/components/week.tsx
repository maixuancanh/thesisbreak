"use client";
import { PagedList } from "./paged-list";
import { usePickReviewEnabled } from "./pick-review-feature";
import Link from "next/link";
import { SignInLink } from "./sign-in-link";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "./ui/button";
import { MarketUpdates } from "./market-updates";
import { ActivityStat } from "./activity-stat";
import { WorkspaceLoading } from "./workspace-loading";
const review = z.object({
  period: z.string(),
  picksRecorded: z.number(),
  conversationsReviewed: z.number(),
  preferencesApproved: z.number(),
  preferenceUses: z.number(),
  usedPreferences: z.array(
    z.object({ id: z.string(), rule: z.string(), uses: z.number() }),
  ),
});
export function Week() {
  const [view, setView] = useState<"Activity" | "Market updates">("Activity");
  const reviewEnabled = usePickReviewEnabled();
  const [data, setData] = useState<z.infer<typeof review> | null>(null),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    setData(null);
    setError("");
    void fetch("/api/review/weekly", { cache: "no-store", signal: c.signal })
      .then(async (r) => {
        if (!r.ok)
          throw new Error(
            r.status === 401
              ? "Sign in to review your week."
              : "Your weekly review is unavailable. Try again later.",
          );
        const value = review.parse(await r.json());
        if (!c.signal.aborted) setData(value);
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(e instanceof Error ? e.message : "Review unavailable.");
      });
    return () => c.abort();
  }, [reload]);
  return (
    <main id="main" className="page narrow week-page">
      <div className="row">
        <div>
          <p className="eyebrow">YOUR THINKING, OVER TIME</p>
          <h1>This week</h1>
          <p className="lead">See which preferences carried forward.</p>
        </div>
        <Button variant="outline" onClick={() => setReload((x) => x + 1)}>
          Refresh
        </Button>
      </div>
      <nav className="memory-filters" aria-label="Weekly sections">
        {(["Activity", "Market updates"] as const).map((tab) => (
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
      {view === "Activity" && (
        <>
          {error ? (
            <div className="connection" role="alert">
              <p>{error}</p>
              {error.startsWith("Sign in") ? (
                <SignInLink>Sign in</SignInLink>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => setReload((value) => value + 1)}
                >
                  Try again
                </Button>
              )}
            </div>
          ) : !data ? (
            <WorkspaceLoading label="Loading your last seven days" />
          ) : (
            <>
              <div className="activity-stats">
                <ActivityStat
                  value={data.picksRecorded}
                  label="Picks recorded"
                />
                <ActivityStat
                  value={data.conversationsReviewed}
                  label="Research replies"
                />
                <ActivityStat
                  value={data.preferencesApproved}
                  label="Preferences approved"
                />
                <ActivityStat
                  value={data.preferenceUses}
                  label="Times remembered"
                />
              </div>
              <div className="activity-note">
                <p className="small muted">{data.period}</p>
                <p className="small muted">
                  These counts show recorded activity. They do not establish
                  prediction accuracy or prove that memory improved a result.
                </p>
              </div>
              {data.usedPreferences.length ? (
                <section className="panel">
                  <h2>Preferences used in replies</h2>
                  <PagedList
                    items={data.usedPreferences}
                    label="Preference usage"
                    size={5}
                  >
                    {(l) => (
                      <div key={`${l.id}:${l.rule}`}>
                        <p>{l.rule}</p>
                        <p className="small muted">
                          Referenced in {l.uses} replies
                        </p>
                      </div>
                    )}
                  </PagedList>
                  <Link href="/memory">Manage preferences</Link>
                </section>
              ) : (
                <div className="empty">
                  <h2>No preference reuse recorded yet</h2>
                  <p>
                    Approve a useful preference, then discuss another event. Its
                    use will appear here when Thesis references it.
                  </p>
                  <Link href="/">Find an event</Link>
                </div>
              )}
            </>
          )}
          {reviewEnabled && (
            <section className="panel">
              <h2>After the event</h2>
              <p>
                Review your initial reason, source changes, your decisions and
                the official result separately.
              </p>
              <Link className="text-link" href="/picks">
                Open your decision recaps →
              </Link>
            </section>
          )}
        </>
      )}
      {view === "Market updates" && <MarketUpdates />}
    </main>
  );
}
