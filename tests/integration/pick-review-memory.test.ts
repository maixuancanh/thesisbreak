import { describe, expect, it } from "vitest";
import {
  buildResearchMemoryRecord,
  researchMemoryBytes,
  researchMemoryHash,
} from "../../packages/domain/src/research-memory-version";
import type { ResearchArtifactClaim } from "../../packages/db/src/research-artifact-memory";
import { verifyResearchArtifactMemory } from "../../packages/integrations/src/research-artifact-memory";
import { researchArtifactTools } from "../../packages/agent/src/research-artifact-policy";
const record = buildResearchMemoryRecord(
  "owner",
  {
    kind: "decision_recap",
    artifactId: "r1",
    logicalId: "research:decision_recap:p1",
    version: 2,
    snapshot: {
      mode: "acceptance_test",
      predecessor_id: "r0",
      evidenceRefs: ["source:1"],
    },
  },
  "2026-11-02T12:00:00Z",
);
const hash = researchMemoryHash("owner", record),
  bytes = researchMemoryBytes("owner", record);
const claim = {
  id: "pub",
  ownerId: "owner",
  reviewerId: "owner",
  grantId: "consent",
  kind: "decision_recap",
  artifactId: "r1",
  record,
  recordHash: hash,
  snapshotHash: "a".repeat(64),
  attempt: 1,
  token: "lease",
  receipt: { hash, blobId: "blob" },
} satisfies ResearchArtifactClaim;
describe("pick review uses existing exact artifact lifecycle", () => {
  it("retains schema2 owner/mode/predecessor inside existing immutable envelope", () => {
    expect(record.payload).toMatchObject({
      schemaVersion: 2,
      namespace: "owner:owner",
      mode: "acceptance_test",
      predecessor: "r0",
    });
    expect(JSON.parse(bytes).schema).toBe(1);
  });
  it("requires fresh exact bytes and rechecks authority after read", async () => {
    let calls = 0;
    const proof = await verifyResearchArtifactMemory(claim, {
      assertAuthority: async () => {
        calls++;
      },
      recall: async () => ({
        sources: [
          {
            blobId: "blob",
            text: bytes,
            record: { schema: 1, userId: "owner", ...record, hash },
          },
        ],
        conflicts: [],
        conflictingBlobs: [],
      }),
    });
    expect(proof.status).toBe("verified");
    expect(calls).toBe(2);
  });
  it.each(["wrong_hash", "wrong_bytes", "wrong_blob", "revoked"])(
    "rejects %s",
    async (mode) => {
      let calls = 0;
      const proof = await verifyResearchArtifactMemory(claim, {
        assertAuthority: async () => {
          calls++;
          if (mode === "revoked" && calls === 2) throw Error("revoked");
        },
        recall: async () => ({
          sources: [
            {
              blobId: mode === "wrong_blob" ? "other" : "blob",
              text: mode === "wrong_bytes" ? bytes + " " : bytes,
              record: {
                schema: 1,
                userId: "owner",
                ...record,
                hash: mode === "wrong_hash" ? "b".repeat(64) : hash,
              },
            },
          ],
          conflicts: [],
          conflictingBlobs: [],
        }),
      });
      expect(proof.status).toBe("blocked");
    },
  );
  it("selects current comparison and official check without granting execution permission", () => {
    expect(
      researchArtifactTools([
        {
          logicalId: record.logicalId,
          version: record.version,
          hash,
          blobId: "blob",
          check: "compare_reason_condition_and_official_result",
          causalBenefit: "not_measured",
        },
      ]).requiredTools,
    ).toEqual(["compare_snapshot", "read_independent_sources"]);
  });
});
