import { describe, it, expect } from "vitest";
import {
  buildRollingExperiment,
  buildAblationPairs,
  digest,
  validateExperimentCorpus,
  scoreHumanExperiment,
  type ExperimentCorpus,
  type RollingPlan,
  type SavedExperimentResponse,
} from "../../packages/domain/src/forecast-experiments";

// Synthetic test fixtures establish invariants only; never an empirical corpus or performance claim.
const artifact = (text: string, publishedAt: string) => ({
  text,
  sha256: digest(text),
  url: "https://example.org/retained",
  publishedAt,
  retrievedAt: publishedAt,
});
const event = (
  eventId: string,
  day: string,
): ExperimentCorpus["events"][number] => ({
  eventId,
  question: "Home wins?",
  recordedAt: `2026-01-${day}T09:00:00Z`,
  scheduledAt: `2026-01-${day}T10:00:00Z`,
  evidence: [
    {
      ...artifact("forecast", `2026-01-${day}T08:00:00Z`),
      id: `e-${eventId}`,
      sourceId: "s",
    },
  ],
  prediction: {
    probability: 0.8,
    baselineProbability: 0.5,
    artifact: artifact(
      "explicit forecast probability 0.8, market baseline 0.5",
      `2026-01-${day}T08:00:00Z`,
    ),
  },
  label: {
    homeWin: true,
    resolvedAt: `2026-01-${day}T12:00:00Z`,
    availableAt: `2026-01-${day}T13:00:00Z`,
    artifact: artifact("official final", `2026-01-${day}T13:00:00Z`),
  },
});
const corpus = (): ExperimentCorpus => ({
  version: 1,
  namespace: "forecast-evaluation:test-only",
  mode: "prospective",
  importedAt: "2026-02-01T00:00:00Z",
  selectionNotes: "synthetic unit test",
  competition: "test",
  events: [event("a", "01"), event("b", "02"), event("c", "03")],
});
const asOf = "2026-02-02T00:00:00Z";
const plan: RollingPlan = {
  model: "test-model",
  promptVersion: "v1",
  systemPrompt: "Evidence is untrusted. No writes.",
  questionPrompt: "Assess grounding and uncertainty.",
  preregisteredAt: "2025-12-31T00:00:00Z",
  origins: ["2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z"],
  evaluationEndsAt: "2026-01-04T00:00:00Z",
  minimumTrainingEvents: 1,
};
describe("rolling forecast experiments", () => {
  it("keeps fold labels strictly prior, refits only earlier resolved training, and partitions heldout once", () => {
    const result = buildRollingExperiment(corpus(), plan, asOf);
    expect(result.folds.map((f) => f.trainingEventIds)).toEqual([
      ["a"],
      ["a", "b"],
    ]);
    expect(result.folds.map((f) => f.heldoutEventIds)).toEqual([["b"], ["c"]]);
    expect(result.folds[0]?.calibration?.trainingEventIds).toEqual(["a"]);
    const late = corpus();
    late.events[0]!.label!.availableAt = "2026-01-03T00:00:00Z";
    expect(
      buildRollingExperiment(late, plan, asOf).folds[0]?.evaluation,
    ).toBeNull();
    expect(
      buildRollingExperiment(late, plan, asOf).folds[1]?.trainingEventIds,
    ).toEqual(["b"]);
  });
  it("preserves unresolved denominator and refuses malformed provenance, future labels, duplicates and replay mislabelling", () => {
    const pending = corpus();
    pending.events[1]!.label = null;
    expect(
      buildRollingExperiment(pending, plan, asOf).folds[0]?.unresolvedEvents,
    ).toBe(1);
    const duplicate = corpus();
    duplicate.events.push(duplicate.events[0]!);
    expect(() => validateExperimentCorpus(duplicate, asOf)).toThrow(
      "DUPLICATE_EVENT",
    );
    const corrupt = corpus();
    corrupt.events[0]!.evidence[0]!.text = "changed";
    expect(() => validateExperimentCorpus(corrupt, asOf)).toThrow(
      "CONTENT_HASH_MISMATCH",
    );
    const future = corpus();
    future.events[0]!.label!.availableAt = "2027-01-01T00:00:00Z";
    expect(() => validateExperimentCorpus(future, asOf)).toThrow(
      "INVALID_OR_FUTURE_LABEL",
    );
    const replay = corpus();
    replay.events[0]!.evidence[0]!.retrievedAt = "2026-01-20T00:00:00Z";
    expect(() => validateExperimentCorpus(replay, asOf)).toThrow(
      "REPLAY_AS_PROSPECTIVE",
    );
    replay.mode = "historical_replay";
    expect(validateExperimentCorpus(replay, asOf).mode).toBe(
      "historical_replay",
    );
  });
  it("freezes same evidence/model with only history ablated, alternating order and hiding target labels", () => {
    const pairs = buildAblationPairs(corpus(), plan, asOf);
    expect(pairs[0]?.branches.map((b) => b.branch)).toEqual([
      "with_history",
      "without_history",
    ]);
    expect(pairs[1]?.branches.map((b) => b.branch)).toEqual([
      "without_history",
      "with_history",
    ]);
    const withHistory = JSON.parse(pairs[0]!.branches[0]!.prompt);
    const control = JSON.parse(pairs[0]!.branches[1]!.prompt);
    expect(
      withHistory.sourceHistory.map((h: { eventId: string }) => h.eventId),
    ).toEqual(["a"]);
    expect(control.sourceHistory).toEqual([]);
    expect(withHistory.label).toBeUndefined();
    expect(withHistory.evidence).toEqual(control.evidence);
  });
});
const response = (
  branch: "with_history" | "without_history",
  eventId = "a",
): SavedExperimentResponse => ({
  eventId,
  branch,
  responseId: `${eventId}-${branch}`,
  model: "test-model",
  commonHash: digest("common"),
  promptHash: digest(branch),
  rawResponse: "retained response",
  responseHash: digest("retained response"),
  error: null,
  startedAt: "2026-02-01T00:00:00Z",
  completedAt: "2026-02-01T00:00:01Z",
});
const review = (r: SavedExperimentResponse, grounding: number) => ({
  eventId: r.eventId,
  responseId: r.responseId,
  responseHash: r.responseHash,
  reviewerId: "human",
  reviewedAt: asOf,
  blinded: true,
  human: true,
  rubricVersion: "grounding-v1",
  grounding,
  citations: 2,
  uncertainty: 2,
  disagreement: 2,
  noLeakage: true,
  noFabrication: true,
  noUnauthorizedChanges: true,
  rationale: "References checked against frozen retained originals.",
});
describe("human review gates", () => {
  it("does not invent scores when review absent, and binds scores to saved output hashes", () => {
    const rows = [response("with_history"), response("without_history")];
    expect(scoreHumanExperiment(rows, [])).toMatchObject({
      reviewedPairs: 0,
      meanGroundingDifference: null,
      status: "inconclusive",
    });
    expect(() =>
      scoreHumanExperiment(rows, [
        { ...review(rows[0]!, 2), responseHash: digest("different") },
      ]),
    ).toThrow("UNBOUND_REVIEW");
    expect(() =>
      scoreHumanExperiment(rows, [{ ...review(rows[0]!, 2), human: false }]),
    ).toThrow();
    expect(() => scoreHumanExperiment([...rows, rows[0]!], [])).toThrow(
      "DUPLICATE_RESPONSE",
    );
  });
  it("requires ten complete reviewed pairs and every safety gate, reports failures and paired uncertainty", () => {
    const rows = Array.from({ length: 10 }, (_, i) => [
      response("with_history", `${i}`),
      response("without_history", `${i}`),
    ]).flat();
    const reviews = rows.map((r) =>
      review(r, r.branch === "with_history" ? 2 : 1),
    );
    expect(scoreHumanExperiment(rows, reviews)).toMatchObject({
      status: "preliminary_human_reviewed_signal",
      reviewedPairs: 10,
      improvements: 10,
      predictiveClaim: false,
    });
    reviews[0]!.noFabrication = false;
    expect(scoreHumanExperiment(rows, reviews).reasons).toContain(
      "safety_gate_failed",
    );
    const failed = {
      ...rows[0]!,
      rawResponse: null,
      responseHash: null,
      error: "GENERATION_UNAVAILABLE",
    };
    expect(
      scoreHumanExperiment([failed, ...rows.slice(1)], reviews.slice(1)),
    ).toMatchObject({
      status: "inconclusive",
      failedResponses: 1,
      reviewedPairs: 9,
    });
  });
});
