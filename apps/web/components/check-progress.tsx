import type { CheckReceipt } from "../../../packages/domain/src/check-procedure";
const names: Record<string, string> = {
  official_lineup: "Official lineup",
  resolution_rules: "Market resolution rules",
  source_disagreement: "Independent source comparison",
};
export function CheckProgress({
  receipts,
  onRetry,
}: {
  receipts: CheckReceipt[];
  onRetry?: (checkId: string) => void;
}) {
  if (!receipts.length)
    return <p className="small muted">No completed procedure check yet.</p>;
  return (
    <ul aria-label="Research checks" className="small">
      {receipts.map((r) => (
        <li key={`${r.checkId}:${r.procedureVersionId}`}>
          <strong>{names[r.checkId] ?? "Evidence check"}: </strong>
          {r.status === "passed" && r.evidenceIds.length
            ? `Checked with ${r.evidenceIds.length} evidence ${r.evidenceIds.length === 1 ? "reference" : "references"}.`
            : r.status === "failed"
              ? "The available evidence does not meet the condition."
              : r.status === "unavailable"
                ? "Could not complete this check."
                : r.status === "unsupported"
                  ? "This source is not supported yet."
                  : "Waiting for a check within the available budget."}
          {onRetry && r.status === "unavailable" && (
            <button
              className="text-link"
              type="button"
              onClick={() => onRetry(r.checkId)}
            >
              Retry {names[r.checkId]?.toLowerCase() ?? "this check"}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
