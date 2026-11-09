"use client";
import { PagedList } from "./paged-list";
import { useEffect, useState } from "react";
import { z } from "zod";
import {
  reviewCasesResponse,
  followupsResponse,
  type ReviewFollowup,
} from "../lib/review-case-client";
import { reviewJson, type PickReview } from "../lib/pick-review-client";
import { ReviewCase } from "./review-case";
import { PickReviewCard } from "./pick-review-card";
import { Button } from "./ui/button";
export function ReviewCaseInbox({
  reviews,
  reload,
  onReview,
  onSaved,
}: {
  reviews: PickReview[];
  reload: number;
  onReview: (review: PickReview) => void;
  onSaved: () => void;
}) {
  const [data, setData] = useState<z.infer<typeof reviewCasesResponse> | null>(
      null,
    ),
    [followups, setFollowups] = useState<ReviewFollowup[]>([]),
    [error, setError] = useState(""),
    [followupError, setFollowupError] = useState(""),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setFollowupError("");
    void fetch("/api/review-cases", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(reviewJson)
      .then((value) => {
        if (!controller.signal.aborted)
          setData(reviewCasesResponse.parse(value));
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Review cases could not be refreshed. Your saved reviews are kept below.",
          );
      });
    void fetch("/api/review-followups", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(reviewJson)
      .then((value) => {
        if (!controller.signal.aborted)
          setFollowups(followupsResponse.parse(value).items);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setFollowupError(
            "Reminder controls could not be loaded. Refresh to try again.",
          );
      });
    return () => controller.abort();
  }, [reload]);
  async function loadMore() {
    if (!data?.nextCursor || loading) return;
    setLoading(true);
    setError("");
    try {
      const next = reviewCasesResponse.parse(
        await reviewJson(
          await fetch(
            `/api/review-cases?cursor=${encodeURIComponent(data.nextCursor)}`,
            { cache: "no-store" },
          ),
        ),
      );
      setData((old) =>
        old
          ? {
              ...next,
              items: [
                ...old.items,
                ...next.items.filter(
                  (n) => !old.items.some((o) => o.id === n.id),
                ),
              ],
              assessments: [
                ...old.assessments,
                ...next.assessments.filter(
                  (n) => !old.assessments.some((o) => o.caseId === n.caseId),
                ),
              ],
            }
          : next,
      );
    } catch {
      setError("More cases could not be loaded. Your current list is kept.");
    } finally {
      setLoading(false);
    }
  }
  const linked = new Set(
    data?.items.flatMap((c) =>
      c.picks.flatMap((p) => (p.assessmentId ? [p.assessmentId] : [])),
    ) ?? [],
  );
  const legacy = reviews.filter((r) => !linked.has(r.id));
  return (
    <section className="reason-section" aria-label="Review cases">
      <h2>Changes to review</h2>
      {error && <p role="alert">{error}</p>}
      {followupError && (
        <p className="small" role="status">
          {followupError}
        </p>
      )}
      {!data && !error && <p role="status">Loading review cases…</p>}
      <div>
        <PagedList
          className="review-grid"
          items={data?.items ?? []}
          label="Review cases"
          size={4}
        >
          {(reviewCase) => (
            <ReviewCase
              key={`${reviewCase.id}:${reviewCase.revision}`}
              reviewCase={reviewCase}
              reviews={reviews}
              assessments={
                data?.assessments.find((a) => a.caseId === reviewCase.id)
                  ?.items ?? []
              }
              followups={followups.filter((f) => f.caseId === reviewCase.id)}
              onReview={onReview}
              onSaved={onSaved}
            />
          )}
        </PagedList>
      </div>
      {data?.nextCursor && (
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => void loadMore()}
        >
          {loading ? "Loading more cases…" : "Load more cases"}
        </Button>
      )}
      {legacy.length > 0 && (
        <div className="reason-section">
          <h3>Other saved reviews</h3>
          <div className="review-grid">
            <PagedList items={legacy} label="Other reviews" size={4}>
              {(review) => (
                <PickReviewCard
                  key={review.id}
                  review={review}
                  count={1}
                  onReview={() => onReview(review)}
                />
              )}
            </PagedList>
          </div>
        </div>
      )}
      {data && !data.items.length && !legacy.length && (
        <p className="muted">No changes need your decision right now.</p>
      )}
    </section>
  );
}
