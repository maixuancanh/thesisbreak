import { randomUUID, createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  candidateSchema,
  experienceSchema,
  learningConditionSchema,
  type LearningAtom,
} from "../../packages/domain/src/experience-learning";
import {
  validateCandidateEvidence,
  learningEvidenceSummary,
} from "../../packages/domain/src/learning-evidence";
const id = randomUUID(),
  text = "Do not change this event before the official lineup.";
const atom: LearningAtom = {
  id,
  origin: "user_statement",
  reference: "run:original",
  version: 1,
  hash: createHash("sha256").update(text).digest("hex"),
  text,
  eventId: "event-A",
  publishedAt: null,
  occurredAt: null,
  retrievedAt: "2026-10-30T00:00:00.000Z",
  sourceOrigin: "user:owner",
};
const candidate = () =>
  candidateSchema.parse({
    requestId: randomUUID(),
    kind: "research_procedure",
    scope: { domain: "Sports", eventId: "event-A" },
    statement: "Require official lineup",
    experienceIds: [randomUUID()],
    evidence: [
      {
        atomId: id,
        version: 1,
        hash: atom.hash,
        stance: "support",
        quote: text,
      },
    ],
    modelVersion: "model",
    promptVersion: "v1",
    condition: {
      type: "require_official_lineup",
      expiresAt: "2026-11-01T00:00:00.000Z",
    },
  });
describe("learning provenance contract", () => {
  it("rejects invented references, hash versions, quotes, injected memories and foreign event scopes", () => {
    const c = candidate();
    expect(validateCandidateEvidence(c, [atom]).distinctEventCount).toBe(1);
    expect(() => validateCandidateEvidence(c, [])).toThrow(
      "INVALID_EVIDENCE_REFERENCE",
    );
    expect(() =>
      validateCandidateEvidence(c, [{ ...atom, hash: "a".repeat(64) }]),
    ).toThrow("INVALID_EVIDENCE_REFERENCE");
    expect(() =>
      validateCandidateEvidence(c, [{ ...atom, text: "paraphrase" }]),
    ).toThrow("UNGROUNDED_QUOTE");
    expect(() =>
      validateCandidateEvidence(c, [{ ...atom, origin: "injected_memory" }]),
    ).toThrow("INELIGIBLE_EVIDENCE_ORIGIN");
    expect(() =>
      validateCandidateEvidence(c, [{ ...atom, eventId: "event-B" }]),
    ).toThrow("EVIDENCE_SCOPE_MISMATCH");
  });
  it("counts repeated same-event sources once without treating paraphrases as independent support", () => {
    const summary = learningEvidenceSummary([
      atom,
      { ...atom, id: randomUUID(), reference: "another-run:same-original" },
      { ...atom, id: randomUUID(), origin: "assistant" },
    ]);
    expect(summary).toEqual({
      originalEvidenceCount: 1,
      distinctEventCount: 1,
      independentOriginCount: 0,
    });
  });
  it("does not count unknown copied URLs or user statements as independent reporting", () => {
    const tools = [
      {
        ...atom,
        id: randomUUID(),
        origin: "tool_result" as const,
        sourceOrigin: "unknown:https://one.example/copy",
      },
      {
        ...atom,
        id: randomUUID(),
        origin: "tool_result" as const,
        sourceOrigin: "https://two.example/copy",
      },
      {
        ...atom,
        id: randomUUID(),
        origin: "tool_result" as const,
        sourceOrigin: "canonical:official",
      },
      {
        ...atom,
        id: randomUUID(),
        origin: "tool_result" as const,
        sourceOrigin: "canonical:official",
      },
    ];
    expect(learningEvidenceSummary(tools).independentOriginCount).toBe(1);
  });
  it("bounds typed parameters and refuses prose probability hypotheses as policy", () => {
    expect(
      learningConditionSchema.safeParse({
        type: "require_fresh_quote",
        expiresAt: "2026-11-01T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      candidateSchema.safeParse({ ...candidate(), kind: "forecast_hypothesis" })
        .success,
    ).toBe(false);
    expect(experienceSchema.safeParse({ ownerId: "attacker" }).success).toBe(
      false,
    );
  });
});
