import { expect, it } from "vitest";
import { auditInventoryRows } from "../../packages/db/src/memory-recovery";
it("fails closed for untrusted records and never counts duplicate logical lessons", () => {
  const result = auditInventoryRows(
    [
      {
        user_id: "other",
        payload: { memoryConsent: true },
        outcome: { record: { logicalId: "x" } },
      },
    ] as never,
    "u",
  );
  expect(result.records).toEqual([]);
  expect(result.summary.verifiedDistinctLessons).toBe(0);
  expect(result.summary.rejectedRecords).toBe(1);
});
it("reports empty inventory without asserting remote completeness", () => {
  expect(auditInventoryRows([], "u").summary.completeness).toBe(
    "local_inventory_only",
  );
});

it("deduplicates verified logical lessons across versions and rejects wrong receipts", async () => {
  const { createHash } = await import("node:crypto");
  const { canonicalMemory } =
    await import("../../packages/db/src/memory-recovery");
  const make = (version: number) => {
    const record = {
      logicalId: "lesson",
      type: "lesson",
      version,
      recordedAt: "2026-10-01T00:00:00.000Z",
      payload: {
        id: "lesson",
        userId: "u",
        version,
        parentVersion: version === 1 ? null : version - 1,
        rule: "Owned rule",
        scope: { domain: "test" },
        approval: "approved",
        status: "active",
        effectiveAt: "2026-10-01T00:00:00.000Z",
        expiresAt: null,
        supersededBy: null,
      },
    };
    const receipt = {
      status: "verified",
      hash: createHash("sha256")
        .update(canonicalMemory({ schema: 1, userId: "u", ...record }))
        .digest("hex"),
      blobId: `blob-${version}`,
    };
    return {
      user_id: "u",
      payload: { memoryConsent: true, lessonId: "lesson", version },
      outcome: { record, result: receipt },
      sync_status: "verified",
      durable_reference: receipt.blobId,
      receipt,
    };
  };
  const first = make(1),
    second = make(2);
  expect(auditInventoryRows([first, first, second], "u").summary).toMatchObject(
    { expectedRecords: 2, verifiedDistinctLessons: 1 },
  );
  expect(
    auditInventoryRows(
      [{ ...first, receipt: { ...first.receipt, blobId: "other" } }],
      "u",
    ).summary.verifiedDistinctLessons,
  ).toBe(0);
  expect(
    auditInventoryRows(
      [{ ...first, receipt: { ...first.receipt, hash: "a".repeat(64) } }],
      "u",
    ).summary.verifiedDistinctLessons,
  ).toBe(0);
});
