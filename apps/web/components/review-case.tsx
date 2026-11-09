"use client";
import Link from "next/link";
import type { ReviewCase as ReviewCaseValue } from "../../../packages/domain/src/review-case";
import type { DecisionEvidenceAssessment } from "../../../packages/domain/src/decision-evidence-assessment";
import type { PickReview } from "../lib/pick-review-client";
import type { ReviewFollowup } from "../lib/review-case-client";
import { Button } from "./ui/button";
import { DecisionEvidenceContext } from "./decision-evidence-context";
import { ReviewFollowupControls } from "./review-followup-controls";
export function ReviewCase({
  reviewCase,
  reviews,
  assessments,
  followups,
  onReview,
  onSaved,
}: {
  reviewCase: ReviewCaseValue;
  reviews: PickReview[];
  assessments: {
    pickId: string;
    reasonId: string;
    assessment: DecisionEvidenceAssessment;
  }[];
  followups: ReviewFollowup[];
  onReview: (review: PickReview) => void;
  onSaved: () => void;
}) {
  const strongest = reviewCase.dissent.find(
    (d) => d.id === reviewCase.strongestObjectionId,
  );
  const first = reviews.find((r) =>
    reviewCase.picks.some((p) => p.assessmentId === r.id),
  );
  return (
    <article className="panel" aria-label="Review case">
      <p className="small muted">
        {reviewCase.picks.filter((p) => p.disposition === "pending").length} of{" "}
        {reviewCase.picks.length} affected picks still need attention
      </p>
      <h3>What changed</h3>
      <p>
        {reviewCase.summary ??
          first?.explanation ??
          "A source connected to your confirmed reason changed. Review each affected pick below."}
      </p>
      {strongest && (
        <div>
          <strong>Strongest objection</strong>
          <p>{strongest.statement}</p>
          {strongest.status === "unknown" && (
            <p className="small muted">This objection still needs evidence.</p>
          )}
        </div>
      )}
      {!reviewCase.dissent.length && (
        <p className="small muted">
          Counterevidence has not been fully assessed yet.
        </p>
      )}
      {reviewCase.missingChecks.length > 0 && (
        <div>
          <strong>Still to check</strong>
          <ul className="small">
            {reviewCase.missingChecks.map((check, i) => (
              <li key={i}>{check}</li>
            ))}
          </ul>
        </div>
      )}
      <ul className="plain-list">
        {reviewCase.picks.map((pick, index) => {
          const review = reviews.find((r) => r.id === pick.assessmentId);
          const assessment = assessments.find(
            (a) => a.pickId === pick.pickId && a.reasonId === pick.reasonId,
          )?.assessment;
          const followup = followups.find(
            (f) =>
              f.pickId === pick.pickId &&
              f.reasonId === pick.reasonId &&
              f.caseRevision === reviewCase.revision,
          );
          return (
            <li
              key={`${pick.pickId}:${pick.reasonId}`}
              className="reason-section"
            >
              <h4>{review?.question ?? `Saved pick ${index + 1}`}</h4>
              <p className="small muted">
                {pick.disposition === "pending"
                  ? "Your decision is still needed."
                  : pick.disposition === "kept"
                    ? "You kept this pick for this change."
                    : pick.disposition === "updated"
                      ? "You updated this pick."
                      : "Reminders for this pick are stopped."}
              </p>
              {assessment && (
                <DecisionEvidenceContext assessment={assessment} />
              )}
              {review && pick.disposition === "pending" ? (
                <Button variant="outline" onClick={() => onReview(review)}>
                  Review this pick
                  <span className="sr-only">
                    : {review.question ?? `saved pick ${index + 1}`}
                  </span>
                </Button>
              ) : (
                pick.disposition === "pending" && (
                  <Link className="text-link" href="/picks">
                    Open saved picks to review this pick
                  </Link>
                )
              )}
              {followup && (
                <ReviewFollowupControls followup={followup} onSaved={onSaved} />
              )}
            </li>
          );
        })}
      </ul>
      <details>
        <summary>Evidence and review details</summary>
        <ul className="small">
          {reviewCase.dissent.map((d) => (
            <li key={d.id}>
              {d.statement}
              <br />
              {d.evidenceIds.length
                ? `Evidence: ${d.evidenceIds.join(", ")}`
                : "Evidence is still needed."}
            </li>
          ))}
        </ul>
        <p className="small muted">
          Review revision {reviewCase.revision}. Each pick keeps its own
          decision.
        </p>
      </details>
    </article>
  );
}
