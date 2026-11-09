import { it, expect } from "vitest";
import { canonicalResearchRows } from "../../packages/db/src/research-cohort";
const row = {
  id: "f",
  event_id: "e",
  horizon: "T24h",
  method_version: "m",
  captured_at: "2026-10-30T00:00:00Z",
  result_recorded_at: "2026-11-01T00:00:00Z",
  revision: 1,
  payload: { probability: 0.7, homeTeam: "H", awayTeam: "A" },
  result: {
    status: "final",
    verifiedOfficial: true,
    sourceUrl: "https://nba.com/game",
    winner: "H",
    retrievedAt: "2026-11-01T00:00:00Z",
  },
};
it("derives labels only from official final results available by the snapshot", () => {
  expect(canonicalResearchRows([row], "2026-11-02T00:00:00Z")[0]).toMatchObject(
    { probability: 0.7, label: 1, primary: true },
  );
  expect(canonicalResearchRows([row], "2026-10-31T00:00:00Z")).toEqual([]);
  expect(
    canonicalResearchRows(
      [{ ...row, result: { ...row.result, status: "disputed" } }],
      "2026-11-02T00:00:00Z",
    ),
  ).toEqual([]);
});
it("excludes malformed provenance", () => {
  expect(
    canonicalResearchRows(
      [{ ...row, result: { ...row.result, retrievedAt: "invalid" } }],
      "2026-11-02T00:00:00Z",
    ),
  ).toEqual([]);
  expect(
    canonicalResearchRows(
      [{ ...row, result: { ...row.result, sourceUrl: "invalid" } }],
      "2026-11-02T00:00:00Z",
    ),
  ).toEqual([]);
});
