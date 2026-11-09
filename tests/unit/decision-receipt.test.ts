import { expect, it } from "vitest";
import {
  assessRecordBinding,
  publicDecisionReceipt,
  decisionReceiptSchema,
} from "../../packages/domain/src/decision-receipt";
it("never treats unrelated or late checkpoints as exact record proof", () => {
  const input = {
    expectedHash: "a".repeat(64),
    expectedRecordId: "r",
    cutoff: "2026-10-30T00:00:00Z",
  };
  expect(assessRecordBinding(input, { capability: "unsupported" }).status).toBe(
    "unsupported",
  );
  expect(
    assessRecordBinding(input, { capability: "account_checkpoint" }).status,
  ).toBe("unsupported");
  const proof = {
    capability: "exact_record" as const,
    recordId: "r",
    hash: input.expectedHash,
    transactionId: "tx",
    checkpoint: "1",
    includedAt: input.cutoff,
  };
  expect(assessRecordBinding(input, proof).status).toBe("verified");
  expect(
    assessRecordBinding(input, { ...proof, hash: "b".repeat(64) }).status,
  ).toBe("mismatch");
  expect(
    assessRecordBinding(input, { ...proof, includedAt: "2026-10-31T00:00:00Z" })
      .status,
  ).toBe("post_cutoff");
});
it("public export is an explicit allowlist and rejects undeclared private fields", () => {
  const receipt = {
    id: "r",
    ownerId: "private-user",
    eventId: "e",
    modelVersion: "model",
    promptVersion: "v1",
    memories: [],
    appliedConditions: [],
    requiredTools: ["official"],
    selectedTools: [],
    executedTools: [],
    evidence: [],
    publication: "pending" as const,
    recordedAt: "2026-10-30T00:00:00Z",
  };
  const legacyTool = {
    name: "old",
    status: "succeeded",
    observedAt: null,
    resultHash: null,
  };
  expect(
    publicDecisionReceipt({ ...receipt, executedTools: [legacyTool] })
      .executedTools,
  ).toEqual([legacyTool]);
  expect(publicDecisionReceipt(receipt)).not.toHaveProperty("ownerId");
  expect(
    decisionReceiptSchema.safeParse({ ...receipt, privatePrompt: "secret" })
      .success,
  ).toBe(false);
});
