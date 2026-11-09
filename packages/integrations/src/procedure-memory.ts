import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { MemoryRecord, MemoryEnvelope } from "./memwal";
import type { ProcedureVersion } from "../../domain/src/procedure-version";
import { procedureContentHash } from "../../domain/src/procedure-version";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function procedureMemoryEnvelopeHash(
  record: MemoryRecord,
  ownerId: string,
): string {
  return createHash("sha256")
    .update(canonical({ schema: 1, userId: ownerId, ...record }))
    .digest("hex");
}
export function buildProcedureMemoryRecord(input: {
  ownerId: string;
  version: ProcedureVersion;
  recordedAt: string;
}): MemoryRecord {
  const v = input.version;
  if (
    !input.ownerId.trim() ||
    !["approved", "active", "retired"].includes(v.status) ||
    !v.reviewerId ||
    !v.reviewedAt ||
    !v.evaluation ||
    v.evaluation.criticalViolations.length ||
    !v.evaluation.validationPassed ||
    !v.evaluation.sealedTestPassed ||
    v.hash !== procedureContentHash(v.content)
  )
    throw Error("PROCEDURE_REVIEW_REQUIRED");
  return {
    logicalId: `global-procedure:${v.id}`,
    type: "approved_procedure_provenance",
    version: 1,
    recordedAt: input.recordedAt,
    payload: {
      userId: input.ownerId,
      scope: "global_procedure_provenance",
      procedureId: v.id,
      procedureHash: v.hash,
      parentId: v.parentId,
      parentHash: v.parentHash,
      content: v.content,
      corpusVersion: v.corpusVersion,
      evaluationReportHash: v.evaluation.reportHash,
      reviewerId: v.reviewerId,
      reviewedAt: v.reviewedAt,
    },
  };
}
export type ProcedureReceipt = { hash: string; blobId: string };
type Result =
  | { status: "verified"; hash: string; blobId: string }
  | { status: "blocked"; reason: string };
function validRecord(ownerId: string, record: MemoryRecord): boolean {
  const p = record.payload;
  return (
    !!p &&
    typeof p === "object" &&
    !Array.isArray(p) &&
    p.userId === ownerId &&
    p.scope === "global_procedure_provenance" &&
    record.type === "approved_procedure_provenance" &&
    record.version === 1
  );
}
export async function publishProcedureProvenance(
  input: { ownerId: string; record: MemoryRecord },
  deps: {
    assertAuthority: () => Promise<void>;
    remember: (
      record: MemoryRecord,
    ) => Promise<{ status: string; hash?: string; blobId?: string }>;
  },
): Promise<Result> {
  try {
    if (!validRecord(input.ownerId, input.record))
      throw Error("PROCEDURE_RECORD_OWNER_MISMATCH");
    await deps.assertAuthority();
    const result = await deps.remember(input.record);
    await deps.assertAuthority();
    if (
      result.status !== "verified" ||
      !result.blobId ||
      result.hash !== procedureMemoryEnvelopeHash(input.record, input.ownerId)
    )
      throw Error("PROCEDURE_RECEIPT_UNVERIFIED");
    return { status: "verified", hash: result.hash, blobId: result.blobId };
  } catch {
    return {
      status: "blocked",
      reason: "procedure_authority_or_receipt_unverified",
    };
  }
}
export async function verifyProcedureProvenance(
  input: { ownerId: string; record: MemoryRecord; receipt: ProcedureReceipt },
  deps: {
    assertAuthority: () => Promise<void>;
    recall: (query: string) => Promise<{
      sources: { record: MemoryEnvelope; blobId: string; text: string }[];
      conflicts: string[];
      conflictingBlobs: string[];
    }>;
  },
): Promise<Result> {
  try {
    if (!validRecord(input.ownerId, input.record))
      throw Error("OWNER_MISMATCH");
    await deps.assertAuthority();
    const remote = await deps.recall(input.record.logicalId);
    await deps.assertAuthority();
    const expectedHash = procedureMemoryEnvelopeHash(
      input.record,
      input.ownerId,
    );
    const key = `${input.record.logicalId}@${input.record.version}`;
    const expected = {
      schema: 1,
      userId: input.ownerId,
      ...input.record,
      hash: expectedHash,
    };
    if (
      input.receipt.hash !== expectedHash ||
      remote.conflicts.includes(key) ||
      remote.conflictingBlobs.includes(input.receipt.blobId) ||
      !remote.sources.some(
        (s) =>
          s.blobId === input.receipt.blobId &&
          isDeepStrictEqual(s.record, expected),
      )
    )
      throw Error("EXACT_READBACK_REQUIRED");
    return { status: "verified", ...input.receipt };
  } catch {
    return {
      status: "blocked",
      reason: "procedure_fresh_read_or_authority_unverified",
    };
  }
}
