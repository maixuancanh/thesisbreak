import { expect, it } from "vitest";
import { assessConfirmedAction } from "../../packages/domain/src/action-outcome";
const row = {
  confirmedAt: "2026-10-01T00:00:00Z",
  scheduledAt: "2026-10-01T01:00:00Z",
  observedAt: "2026-10-01T04:00:00Z",
  status: "final" as const,
  rulesMatch: true,
  winner: "No",
  before: "Yes",
  after: "No",
};
it("compares confirmed actions without claiming causal improvement", () => {
  expect(assessConfirmedAction(row)).toMatchObject({
    beforeMatched: false,
    afterMatched: true,
    evidenceLevel: "observational",
    improvementEstablished: false,
  });
});
it("rejects late, unknown, premature and changed-rules results", () => {
  for (const extra of [
    { scheduledAt: null },
    { confirmedAt: row.scheduledAt },
    { rulesMatch: false },
    { observedAt: row.confirmedAt },
    { winner: null },
    { status: "pending" as const },
  ])
    expect(assessConfirmedAction({ ...row, ...extra }).afterMatched).toBeNull();
});
