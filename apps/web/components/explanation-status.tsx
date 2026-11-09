import type { ExplanationStatus as Status } from "../../../packages/domain/src/explanation-review";
export const explanationStatusText = (status: Status) =>
  ({
    not_assessed: "Explanation not yet checked",
    supported: "Explanation supported by the checked evidence",
    under_review: "Explanation under review",
    corrected: "Explanation updated after review",
    inconclusive: "Explanation remains inconclusive",
  })[status];
export function ExplanationStatus({
  status = "not_assessed",
}: {
  status?: Status;
}) {
  return (
    <p className="small muted" role="status">
      {explanationStatusText(status)}
      {status === "under_review"
        ? " · Related lessons are held until this evidence is resolved."
        : ""}
    </p>
  );
}
