import { describe, expect, it } from "vitest";
import {
  claimAnchorSchema,
  submitClaimChallengeSchema,
} from "../../packages/domain/src/claim-challenge";
import {
  reviewCaseSchema,
  reviewDissentSchema,
} from "../../packages/domain/src/review-case";
import { checkReceiptSchema } from "../../packages/domain/src/check-procedure";
import { decisionEvidenceAssessmentSchema } from "../../packages/domain/src/decision-evidence-assessment";
const anchor = {
  ownerId: "owner",
  sessionId: "session",
  messageId: "run",
  answerRevision: 1,
  claimId: "claim",
  claimTextHash: "a".repeat(64),
};
describe("accountability strict contracts", () => {
  it("requires exact persisted claim hash and positive revisions", () => {
    expect(claimAnchorSchema.safeParse(anchor).success).toBe(true);
    for (const patch of [
      { claimTextHash: undefined },
      { claimTextHash: "fake" },
      { answerRevision: -1 },
      { answerRevision: 0 },
    ])
      expect(claimAnchorSchema.safeParse({ ...anchor, ...patch }).success).toBe(
        false,
      );
  });
  it("rejects client owner and injected fields", () => {
    const request = {
      messageId: "run",
      answerRevision: 1,
      claimId: "claim",
      explanation: "Please check",
      evidenceUrls: [],
      clientRequestId: "request",
    };
    expect(submitClaimChallengeSchema.safeParse(request).success).toBe(true);
    expect(
      submitClaimChallengeSchema.safeParse({ ...request, ownerId: "other" })
        .success,
    ).toBe(false);
    expect(
      submitClaimChallengeSchema.safeParse({
        ...request,
        evidenceUrls: Array(6).fill("https://example.com"),
      }).success,
    ).toBe(false);
  });
  it("requires cited dissent or explicit unknown", () => {
    expect(
      reviewDissentSchema.safeParse({
        id: "d",
        statement: "Objection",
        evidenceIds: [],
        status: "supported",
      }).success,
    ).toBe(false);
    expect(
      reviewDissentSchema.safeParse({
        id: "d",
        statement: "Objection",
        evidenceIds: [],
        status: "unknown",
      }).success,
    ).toBe(true);
    expect(reviewCaseSchema.safeParse({}).success).toBe(false);
  });
  it("does not allow checked-without-evidence or invented enums", () => {
    const receipt = {
      checkId: "c",
      procedureVersionId: "p",
      tool: "official",
      status: "passed",
      evidenceIds: [],
      checkedAt: "2026-11-03T00:00:00Z",
    };
    expect(checkReceiptSchema.safeParse(receipt).success).toBe(false);
    expect(
      checkReceiptSchema.safeParse({ ...receipt, evidenceIds: ["e"] }).success,
    ).toBe(true);
    expect(
      checkReceiptSchema.safeParse({ ...receipt, status: "probably" }).success,
    ).toBe(false);
  });
  it("blocks probability without a validated challenger and priced-in assertions", () => {
    const a = {
      reasonImpact: "invalidated",
      priceAssessment: "unknown",
      adjustmentStatus: "insufficient_evidence",
      needsReview: true,
      adjustedProbability: null,
      evidenceIds: [],
      configVersion: "1",
      checkedAt: "2026-11-03T00:00:00Z",
    };
    expect(decisionEvidenceAssessmentSchema.safeParse(a).success).toBe(true);
    expect(
      decisionEvidenceAssessmentSchema.safeParse({
        ...a,
        adjustedProbability: 0.7,
      }).success,
    ).toBe(false);
    expect(
      decisionEvidenceAssessmentSchema.safeParse({ ...a, pricedIn: true })
        .success,
    ).toBe(false);
  });
});
