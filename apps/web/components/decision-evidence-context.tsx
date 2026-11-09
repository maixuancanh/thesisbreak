import type { DecisionEvidenceAssessment } from "../../../packages/domain/src/decision-evidence-assessment";
export function DecisionEvidenceContext({
  assessment,
}: {
  assessment: DecisionEvidenceAssessment;
}) {
  return (
    <div className="small">
      <p>
        {assessment.needsReview
          ? "Your reason needs another look."
          : assessment.reasonImpact === "unchanged"
            ? "This check has not weakened your reason."
            : "The effect on your reason is still unclear."}{" "}
        {assessment.adjustedProbability === null
          ? "There isn’t enough evidence to revise the forecast."
          : "A separately validated forecast candidate is available for review."}
      </p>
      <p className="muted">
        {assessment.priceAssessment === "movement_observed"
          ? "Recorded quotes moved. This does not establish why the price changed."
          : assessment.priceAssessment === "no_observed_movement"
            ? "The comparable recorded quotes show no material movement."
            : "Price context is unavailable. Your reason can still need review."}
      </p>
      {assessment.quoteContext &&
        (assessment.quoteContext.before || assessment.quoteContext.after) && (
          <details>
            <summary>Recorded price evidence</summary>
            <ul>
              {(["before", "after"] as const).map((key) => {
                const q = assessment.quoteContext?.[key];
                return q ? (
                  <li key={key}>
                    {key === "before" ? "Before" : "After"}: {q.provider},{" "}
                    {q.quoteType.replaceAll("_", " ")},{" "}
                    {(q.probability * 100).toFixed(1)}%, observed {q.observedAt}
                    {q.spread === null
                      ? "; spread unavailable"
                      : `; spread ${(q.spread * 100).toFixed(1)} percentage points`}
                  </li>
                ) : (
                  <li key={key}>
                    {key === "before" ? "Before" : "After"} quote unavailable
                  </li>
                );
              })}
            </ul>
          </details>
        )}
    </div>
  );
}
