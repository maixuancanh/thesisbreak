import { describe, it, expect } from "vitest";
import {
  submitClaimChallengeSchema,
  withdrawClaimChallengeSchema,
} from "../../packages/domain/src/claim-challenge";
import { validateChallengeVerdict } from "../../packages/integrations/src/claim-challenge-worker";
import { claimTextHash } from "../../packages/db/src/claim-challenges";
const input = {
  messageId: "message",
  answerRevision: 1,
  claimId: "claim",
  explanation: "The reported lineup differs.",
  evidenceUrls: [],
  clientRequestId: "request",
};
const source = {
  id: "source:1",
  url: "https://example.org/report",
  hash: "a".repeat(64),
  text: "The official lineup excludes player A.",
  retrievedAt: new Date().toISOString(),
};
describe("claim challenge request and verification boundaries", () => {
  it("rejects client ownership and revision manipulation", () => {
    expect(
      submitClaimChallengeSchema.safeParse({ ...input, ownerId: "other" })
        .success,
    ).toBe(false);
    expect(
      submitClaimChallengeSchema.safeParse({ ...input, answerRevision: 0 })
        .success,
    ).toBe(false);
    expect(
      submitClaimChallengeSchema.safeParse({
        ...input,
        claimTextHash: "forged",
      }).success,
    ).toBe(false);
    expect(
      withdrawClaimChallengeSchema.safeParse({
        action: "accept",
        expectedRevision: 1,
      }).success,
    ).toBe(false);
  });
  it("bounds evidence, prose and withdrawal revision", () => {
    expect(
      submitClaimChallengeSchema.safeParse({
        ...input,
        explanation: "x".repeat(4001),
      }).success,
    ).toBe(false);
    expect(
      submitClaimChallengeSchema.safeParse({
        ...input,
        evidenceUrls: Array(6).fill(source.url),
      }).success,
    ).toBe(false);
    expect(
      withdrawClaimChallengeSchema.safeParse({
        action: "withdraw",
        expectedRevision: -1,
      }).success,
    ).toBe(false);
  });
  it("does not accept a user assertion or fabricated quotation", () => {
    expect(() =>
      validateChallengeVerdict(
        {
          status: "accepted",
          explanation: "User says so",
          correctionText: "Changed",
          citations: [],
        },
        [],
      ),
    ).toThrow("CHALLENGE_EVIDENCE_REQUIRED");
    expect(() =>
      validateChallengeVerdict(
        {
          status: "accepted",
          explanation: "Evidence",
          correctionText: "Changed",
          citations: [{ evidenceId: source.id, quote: "Player A starts." }],
        },
        [source],
      ),
    ).toThrow("INVALID_CHALLENGE_CITATION");
  });
  it("permits current correction only with an exact retained citation", () => {
    const checked = validateChallengeVerdict(
      {
        status: "accepted",
        explanation: "The source contradicts this claim.",
        correctionText: "The current official lineup excludes player A.",
        citations: [{ evidenceId: source.id, quote: source.text }],
      },
      [source],
    );
    expect(checked.status).toBe("accepted");
  });
  it("keeps unavailable evidence unresolved without a correction", () => {
    expect(
      validateChallengeVerdict(
        {
          status: "needs_evidence",
          explanation: "The official source is unavailable.",
          correctionText: null,
          citations: [],
        },
        [],
      ).status,
    ).toBe("needs_evidence");
    expect(() =>
      validateChallengeVerdict(
        {
          status: "not_supported",
          explanation: "No evidence",
          correctionText: "Changed",
          citations: [{ evidenceId: source.id, quote: source.text }],
        },
        [source],
      ),
    ).toThrow("UNSUPPORTED_CORRECTION");
  });
  it("anchors exact text including punctuation", () =>
    expect(claimTextHash("A starts.")).not.toBe(claimTextHash("A starts")));
});
