/** Observational comparison of an explicitly confirmed decision, never causal attribution. */
export function assessConfirmedAction(input: {
  confirmedAt: string;
  scheduledAt: string | null;
  rulesMatch: boolean;
  status: "final" | "pending";
  observedAt: string;
  winner: string | null;
  before: string;
  after: string;
}) {
  const t = (x: string | null) => (x ? Date.parse(x) : NaN);
  const scorable =
    input.status === "final" &&
    input.winner !== null &&
    input.rulesMatch &&
    Number.isFinite(t(input.scheduledAt)) &&
    t(input.confirmedAt) < t(input.scheduledAt) &&
    t(input.observedAt) >= t(input.scheduledAt);
  return {
    status: scorable ? "observed_final" : "pending_or_unscorable",
    beforeMatched: scorable ? input.before === input.winner : null,
    afterMatched: scorable ? input.after === input.winner : null,
    evidenceLevel: "observational" as const,
    improvementEstablished: false as const,
  };
}
