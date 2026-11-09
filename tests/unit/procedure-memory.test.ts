import { describe, expect, it } from "vitest";
import { applyReviewedProcedureToSystem } from "../../packages/domain/src/procedure-version";
import {
  buildProcedureMemoryRecord,
  publishProcedureProvenance,
  verifyProcedureProvenance,
} from "../../packages/integrations/src/procedure-memory";
import {
  createProcedureVersion,
  evaluateProcedure,
  reviewProcedure,
} from "../../packages/domain/src/procedure-version";
const report = {
  reportHash: "b".repeat(64),
  corpusVersion: "c1",
  criticalViolations: [],
  grounding: 1,
  actionCompliance: 1,
  latencyMs: 1,
  costUsd: 0,
  validationPassed: true,
  sealedTestPassed: true,
};
const approved = reviewProcedure(
  evaluateProcedure(
    createProcedureVersion({
      id: "p1",
      parentId: null,
      parentHash: null,
      content: {
        researchInstructions: "Read official evidence",
        queryTemplates: [],
        proposedReadOrder: [],
      },
      corpusVersion: "c1",
      failureExampleIds: [],
    }),
    report,
  ),
  { reviewerId: "reviewer", at: "2026-11-02T00:00:00Z", approve: true },
);
const record = () =>
  buildProcedureMemoryRecord({
    ownerId: "evaluation-owner",
    version: approved,
    recordedAt: "2026-11-02T00:00:00Z",
  });
describe("procedure provenance fresh verification", () => {
  it("preserves original system and personal conditions as final authority", () => {
    const system = "Personal condition: never change my pick";
    const merged = applyReviewedProcedureToSystem(system, approved.content);
    expect(merged.endsWith(system)).toBe(true);
    expect(merged).toContain("subordinate");
  });
  it("publishes only when current explicit grant exists before and after the write", async () => {
    let writes = 0,
      checks = 0;
    const job = { record: record(), ownerId: "evaluation-owner" };
    const result = await publishProcedureProvenance(job, {
      assertAuthority: async () => {
        if (++checks > 1) throw Error("REVOKED");
      },
      remember: async () => {
        writes++;
        return { status: "verified", hash: "c".repeat(64), blobId: "blob" };
      },
    });
    expect(writes).toBe(1);
    expect(result.status).toBe("blocked");
    await publishProcedureProvenance(job, {
      assertAuthority: async () => {
        throw Error("NO_CONSENT");
      },
      remember: async () => {
        writes++;
        return { status: "verified", hash: "c".repeat(64), blobId: "blob" };
      },
    });
    expect(writes).toBe(1);
  });
  it("rejects wrong owner/hash/blob and revocation during a fresh remote read", async () => {
    const r = record();
    const expected = { hash: "c".repeat(64), blobId: "blob" };
    const source = {
      record: {
        schema: 1 as const,
        userId: "evaluation-owner",
        ...r,
        hash: expected.hash,
      },
      blobId: "different",
      text: "",
    };
    const deps = {
      assertAuthority: async () => {},
      recall: async () => ({
        sources: [source],
        conflicts: [],
        conflictingBlobs: [],
      }),
    };
    expect(
      (
        await verifyProcedureProvenance(
          { ownerId: "evaluation-owner", record: r, receipt: expected },
          deps,
        )
      ).status,
    ).toBe("blocked");
    source.blobId = "blob";
    source.record.userId = "foreign";
    expect(
      (
        await verifyProcedureProvenance(
          { ownerId: "evaluation-owner", record: r, receipt: expected },
          deps,
        )
      ).status,
    ).toBe("blocked");
    source.record.userId = "evaluation-owner";
    let checks = 0;
    expect(
      (
        await verifyProcedureProvenance(
          { ownerId: "evaluation-owner", record: r, receipt: expected },
          {
            ...deps,
            assertAuthority: async () => {
              if (++checks > 1) throw Error("REVOKED");
            },
          },
        )
      ).status,
    ).toBe("blocked");
  });
});
