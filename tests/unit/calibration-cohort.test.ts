import { expect, it } from "vitest";
import { chronologicalCalibrationCohort } from "../../packages/db/src/research-cohort";
const rows = Array.from({ length: 200 }, (_, i) => ({
  forecastId: `f${i}`,
  eventId: `e${i}`,
  outcomeVersion: 1,
  challengerVersion: "v1",
  availableAt: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
  cutoffAt: "2024-01-01T00:00:00Z",
  probability: 0.5,
  label: (i % 2) as 0 | 1,
  league: "NBA",
  marketType: "winner",
  horizon: "T24h",
  primary: true,
}));
it("freezes chronological event-disjoint splits and refuses insufficient support", () => {
  expect(
    chronologicalCalibrationCohort(rows.slice(0, 20), "2026-01-01T00:00:00Z"),
  ).toBeNull();
  const cohort = chronologicalCalibrationCohort(rows, "2026-01-01T00:00:00Z")!;
  expect(cohort.train).toHaveLength(120);
  expect(cohort.validation).toHaveLength(40);
  expect(cohort.heldout).toHaveLength(40);
  expect(
    cohort.train.at(-1)!.availableAt < cohort.validation[0]!.availableAt,
  ).toBe(true);
  expect(
    cohort.validation.at(-1)!.availableAt < cohort.heldout[0]!.availableAt,
  ).toBe(true);
  expect(
    chronologicalCalibrationCohort(
      rows.map((r) => ({ ...r, availableAt: "2025-01-01T00:00:00Z" })),
      "2026-01-01T00:00:00Z",
    ),
  ).toBeNull();
});
