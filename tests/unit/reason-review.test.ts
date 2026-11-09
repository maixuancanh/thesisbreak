import { it, expect } from "vitest";
import {
  createAgentContext,
  answerWithContext,
} from "../../packages/agent/src/context";
const now = new Date("2026-10-26T10:00:00Z");
const input = {
  userId: "u",
  market: {
    platform: "kalshi" as const,
    nativeId: "TEST",
    question: "A wins?",
    outcomes: ["Yes", "No"],
    rules: "Rules",
  },
  pick: {
    userId: "u",
    pickId: "p",
    market: { platform: "kalshi" as const, nativeId: "TEST" },
    version: 1,
    outcome: "Yes",
    reason: "Player will start",
  },
  evidence: [
    {
      userId: "u",
      id: "price",
      market: { platform: "kalshi" as const, nativeId: "TEST" },
      text: "Price rose",
      publishedAt: null,
      retrievedAt: now.toISOString(),
      kind: "market" as const,
    },
    {
      userId: "u",
      id: "report",
      market: { platform: "kalshi" as const, nativeId: "TEST" },
      text: "Player is out",
      publishedAt: null,
      retrievedAt: now.toISOString(),
      kind: "official_event" as const,
    },
  ],
  lessons: [],
  now,
};
const base = {
  message: "Review",
  evidenceRefs: ["report"],
  lessonRefs: [],
  proposedChange: null,
};
const review = {
  baseVersion: 1,
  summary: "An assumption needs review",
  claims: [
    {
      claim: "Player will start",
      status: "contradicted",
      explanation: "Official report lists player out",
      evidenceRefs: ["report"],
    },
  ],
};
it("accepts cited official reason review but rejects market-price-only contradiction", async () => {
  const c = createAgentContext(input);
  expect(
    (
      await answerWithContext(c, "Review", async () => ({
        ...base,
        reasonReview: review,
      }))
    ).reasonReview,
  ).toEqual(review);
  await expect(
    answerWithContext(c, "Review", async () => ({
      ...base,
      reasonReview: {
        ...review,
        claims: [{ ...review.claims[0], evidenceRefs: ["price"] }],
      },
    })),
  ).rejects.toThrow("INSUFFICIENT_REVIEW_EVIDENCE");
  await expect(
    answerWithContext(c, "Review", async () => ({
      ...base,
      reasonReview: { ...review, baseVersion: 2 },
    })),
  ).rejects.toThrow("STALE_REASON_REVIEW");
});
it("cannot invent a final outcome or review a missing saved pick", async () => {
  const retrospective = {
    baseVersion: 1,
    summary: "Outcome matched but reasoning uncertain",
    reasoningLesson: "Confirm the lineup before relying on it.",
    evidenceRefs: ["report", "settlement"],
  };
  await expect(
    answerWithContext(createAgentContext(input), "Review result", async () => ({
      ...base,
      retrospective,
    })),
  ).rejects.toThrow("SETTLEMENT_REQUIRED");
  await expect(
    answerWithContext(
      createAgentContext({ ...input, pick: null }),
      "Review",
      async () => ({ ...base, reasonReview: review }),
    ),
  ).rejects.toThrow("STALE_REASON_REVIEW");
});
it("accepts a post-result lesson draft only with authoritative settlement and supplied citations", async () => {
  const c = createAgentContext({
    ...input,
    evidence: [
      ...input.evidence,
      { ...input.evidence[0]!, id: "settlement", kind: "settlement" as const },
    ],
    settlement: {
      outcome: "Yes",
      resolvedAt: "2026-10-26T09:00:00Z",
      pickRecordedAt: "2026-10-25T09:00:00Z",
      sourceRef: "settlement",
    },
  });
  const retrospective = {
    baseVersion: 1,
    summary: "Matched outcome does not prove sound reasoning",
    reasoningLesson: "Confirm the lineup before relying on it.",
    evidenceRefs: ["report", "settlement"],
  };
  expect(
    (
      await answerWithContext(c, "Review result", async () => ({
        ...base,
        retrospective,
      }))
    ).retrospective,
  ).toEqual(retrospective);
  await expect(
    answerWithContext(c, "Review result", async () => ({
      ...base,
      retrospective: { ...retrospective, evidenceRefs: ["invented"] },
    })),
  ).rejects.toThrow("UNKNOWN_REVIEW_CITATION");
  await expect(
    answerWithContext(c, "Review result", async () => ({
      ...base,
      retrospective: { ...retrospective, evidenceRefs: ["report"] },
    })),
  ).rejects.toThrow("SETTLEMENT_CITATION_REQUIRED");
});
