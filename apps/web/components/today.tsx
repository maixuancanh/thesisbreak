"use client";
import { PagedList } from "./paged-list";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { z } from "zod";
import { Button } from "./ui/button";
import { SignInLink } from "./sign-in-link";
import { WorkspaceLoading } from "./workspace-loading";
import { ContextualThesis } from "./contextual-thesis";
import { PickReviewCard } from "./pick-review-card";
import { PickReviewDrawer } from "./pick-review-drawer";
import { SharedReasons } from "./shared-reasons";
import { ReviewCaseInbox } from "./review-case-inbox";
import {
  reviewsResponse,
  sharedResponse,
  reviewJson,
  type PickReview,
} from "../lib/pick-review-client";
import { friendlyDate } from "../lib/live-market";
export function Today({
  accountabilityEnabled = false,
}: { accountabilityEnabled?: boolean } = {}) {
  const [data, setData] = useState<z.infer<typeof reviewsResponse> | null>(
      null,
    ),
    [shared, setShared] = useState<z.infer<typeof sharedResponse> | null>(null),
    [error, setError] = useState(""),
    [sharedError, setSharedError] = useState(""),
    [reload, setReload] = useState(0),
    [selected, setSelected] = useState<PickReview | null>(null),
    [discussion, setDiscussion] = useState<PickReview | null>(null),
    [chatVisible, setChatVisible] = useState(false),
    [chatGeneration, setChatGeneration] = useState(0),
    [notice, setNotice] = useState(""),
    [loadingMore, setLoadingMore] = useState(false);
  const focus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const c = new AbortController();
    setError("");
    void fetch("/api/reviews", { cache: "no-store", signal: c.signal })
      .then(reviewJson)
      .then((value) => {
        if (!c.signal.aborted) setData(reviewsResponse.parse(value));
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(
            e instanceof z.ZodError
              ? "Your reviews could not be read. Refresh to try again."
              : (e as Error).message,
          );
      });
    void fetch("/api/picks/shared-reasons", {
      cache: "no-store",
      signal: c.signal,
    })
      .then(reviewJson)
      .then((value) => {
        if (!c.signal.aborted) {
          setShared(sharedResponse.parse(value));
          setSharedError("");
        }
      })
      .catch(() => {
        if (!c.signal.aborted)
          setSharedError(
            "Shared reasons could not be checked. Your picks are unchanged.",
          );
      });
    return () => c.abort();
  }, [reload]);
  async function loadMore() {
    if (!data?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await fetch(
        `/api/reviews?cursor=${encodeURIComponent(data.nextCursor)}`,
        { cache: "no-store" },
      );
      const next = reviewsResponse.parse(await reviewJson(r));
      setData((old) =>
        old
          ? {
              ...next,
              items: [
                ...old.items,
                ...next.items.filter(
                  (n) => !old.items.some((i) => i.id === n.id),
                ),
              ],
            }
          : next,
      );
    } catch {
      setError("More reviews could not be loaded. Your current inbox is kept.");
    } finally {
      setLoadingMore(false);
    }
  }
  const items = data?.items.filter((x) => !x.closed) ?? [];
  function close() {
    setSelected(null);
    requestAnimationFrame(() => focus.current?.focus());
  }
  const states = [
    ["needs_review", "Needs another look"],
    ["waiting_confirmation", "Waiting for confirmation"],
    ["still_watching", "Still watching"],
  ] as const;
  return (
    <main
      id="main"
      className={`page today-page ${chatVisible ? "has-discussion" : ""}`}
    >
      <div className="today-content">
        <div className="row">
          <div>
            <p className="eyebrow">YOUR PICKS, IN CONTEXT</p>
            <h1>Today</h1>
            <p className="lead">Know what deserves another look.</p>
          </div>
          <Button variant="outline" onClick={() => setReload((x) => x + 1)}>
            Refresh
          </Button>
        </div>
        {notice && <p role="status">{notice}</p>}
        {error && (
          <div className="connection" role="alert">
            <p>{error}</p>
            {error.startsWith("Sign in") && (
              <SignInLink returnTo="/today">Sign in</SignInLink>
            )}
          </div>
        )}
        {!data && !error && (
          <WorkspaceLoading label="Checking your review inbox" />
        )}
        {data && (
          <>
            <p className="small muted">
              {data.coverage.trackedPicks} of {data.coverage.totalPicks} picks
              have reason monitoring configured.{" "}
              {data.lastCheckedAt
                ? `Last checked ${friendlyDate(data.lastCheckedAt)}`
                : "No completed check yet."}
            </p>
            {items.some((i) => i.state === "check_unavailable") && (
              <div className="connection" role="status">
                <strong>Some sources could not be checked</strong>
                <p>We couldn’t check this source. Your pick is unchanged.</p>
                {items
                  .filter((i) => i.state === "check_unavailable")
                  .map((i) => (
                    <Button
                      key={i.id}
                      variant="outline"
                      onClick={(e) => {
                        focus.current = e.currentTarget;
                        setSelected(i);
                      }}
                    >
                      Review source check
                    </Button>
                  ))}
              </div>
            )}
            {data.coverage.unconfiguredPicks > 0 && (
              <section className="panel">
                <h2>Add your reason</h2>
                <p>
                  {data.coverage.unconfiguredPicks} picks have no confirmed
                  reason to watch for changes.
                </p>
                <Link className="text-link" href="/picks">
                  Add your reason →
                </Link>
              </section>
            )}
            {!data.coverage.totalPicks ? (
              <div className="empty">
                <h2>Start with a considered pick</h2>
                <p>Choose a market and record why you think so.</p>
                <Button asChild>
                  <Link href="/">Choose a market</Link>
                </Button>
              </div>
            ) : accountabilityEnabled ? (
              <ReviewCaseInbox
                reviews={items}
                reload={reload}
                onReview={(review) => {
                  focus.current = document.activeElement as HTMLElement;
                  setSelected(review);
                }}
                onSaved={() => {
                  setNotice("Reminder saved. Refreshing the remaining work…");
                  setReload((x) => x + 1);
                }}
              />
            ) : (
              states.map(([state, label]) => {
                const rows = items.filter((i) => i.state === state);
                const groups = [...new Set(rows.map((i) => i.changeId))];
                if (!groups.length && state !== "needs_review") return null;
                return (
                  <section className="reason-section" key={state}>
                    <h2>
                      {label}{" "}
                      <span className="review-count muted">
                        {groups.length}
                      </span>
                    </h2>
                    {groups.length ? (
                      <PagedList
                        items={groups}
                        label={label}
                        className="review-grid"
                        size={4}
                      >
                        {(id) => {
                          const group = rows.filter((i) => i.changeId === id);
                          return (
                            <PickReviewCard
                              key={id}
                              review={group[0]!}
                              count={
                                group[0]!.affectedPickCount ?? group.length
                              }
                              partial={
                                !!data.nextCursor &&
                                group[0]!.affectedPickCount === undefined
                              }
                              onReview={() => {
                                focus.current =
                                  document.activeElement as HTMLElement;
                                setSelected(group[0]!);
                              }}
                            />
                          );
                        }}
                      </PagedList>
                    ) : (
                      <p className="muted">
                        {state === "needs_review"
                          ? "No changes need your decision right now."
                          : state === "waiting_confirmation"
                            ? "No picks are waiting for confirmation."
                            : "No review cards in this group. Your monitoring coverage is shown above."}
                      </p>
                    )}
                  </section>
                );
              })
            )}
          </>
        )}
        {data?.nextCursor && (
          <p className="small muted">
            More reviews are available. Group headings reflect the reviews
            loaded so far.
          </p>
        )}
        {data?.nextCursor && (
          <Button
            variant="outline"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? "Loading more…" : "Load more reviews"}
          </Button>
        )}
        {shared && <SharedReasons data={shared} reviews={data?.items ?? []} />}{" "}
        {sharedError && (
          <p className="small muted" role="status">
            {sharedError}
          </p>
        )}
      </div>
      {discussion && (
        <div className="today-discussion" hidden={!chatVisible}>
          <Button variant="outline" onClick={() => setChatVisible(false)}>
            ← Back to Today
          </Button>
          <Button
            variant="ghost"
            onClick={() => setChatGeneration((x) => x + 1)}
          >
            New chat
          </Button>
          <ContextualThesis
            key={chatGeneration}
            provider="public"
            reviewId={discussion.id}
            reviewPickId={discussion.pickId}
            initialMessage={`Help me review this change to my pick: ${discussion.question ?? "Saved pick"}. My confirmed reason: ${discussion.userText}. What changed: ${discussion.explanation}`.slice(
              0,
              3000,
            )}
          />
        </div>
      )}
      <PickReviewDrawer
        review={selected}
        affected={items.filter((i) => i.changeId === selected?.changeId)}
        onSelect={setSelected}
        onClose={close}
        onSuccess={() => {
          setNotice("Decision recorded. Refreshing your inbox…");
          setReload((x) => x + 1);
        }}
        onDiscuss={(r) => {
          setSelected(null);
          setDiscussion(r);
          setChatVisible(true);
        }}
      />
    </main>
  );
}
