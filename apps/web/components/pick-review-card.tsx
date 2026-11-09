"use client";
import { Button } from "./ui/button";
import { friendlyDate } from "../lib/live-market";
import type { PickReview } from "../lib/pick-review-client";
export function PickReviewCard({
  review,
  count,
  partial = false,
  onReview,
}: {
  review: PickReview;
  count: number;
  partial?: boolean;
  onReview: () => void;
}) {
  return (
    <article className="panel pick-review-card">
      <p className="small muted">
        {count} {partial ? "loaded " : ""}
        {count === 1 ? "pick" : "picks"} affected
      </p>
      <h3>{review.question ?? "Your saved pick"}</h3>
      <p>{review.explanation}</p>
      <p className="small muted">
        Last checked {friendlyDate(review.checkedAt)}
      </p>
      <Button variant="outline" onClick={onReview}>
        Review
        <span className="sr-only"> {review.question ?? "saved pick"}</span>
      </Button>
    </article>
  );
}
