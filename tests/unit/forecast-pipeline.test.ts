import { expect, it } from "vitest";
import { prepareNbaForecast } from "../../packages/integrations/src/forecast-pipeline";
const base = {
  asOf: "2026-10-28T10:00:00Z",
  homeTeam: "BOS",
  awayTeam: "BKN",
  homeRestDays: 2,
  awayRestDays: 1,
  games: [],
  config: {},
  requiresLineup: true,
  lineupConfirmed: false,
  staleEvidence: false,
  conflictingEvidence: false,
  evidenceRefs: ["official"],
};
it("records an abstention instead of leaking a probability when required lineup is absent", () => {
  expect(prepareNbaForecast(base)).toMatchObject({
    probability: null,
    abstentionReason: "lineup_pending",
    validatedPredictiveImprovement: false,
  });
});
it("produces reproducible statistical probability only when prerequisites pass", () => {
  const r = prepareNbaForecast({ ...base, lineupConfirmed: true });
  expect(r.probability).toBeGreaterThan(0.5);
  expect(r.trainingEventIds).toEqual([]);
});
