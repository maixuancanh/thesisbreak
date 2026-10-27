import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { lessonVersionSchema } from "../../domain/src/lesson";
import type { MemoryRecord } from "../../integrations/src/memwal";
import { validateSourceScore } from "../../domain/src/source-credibility";
export function canonicalMemory(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalMemory).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalMemory(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
interface InventoryRow {
  user_id: string;
  payload: {
    memoryConsent?: boolean;
    lessonId?: string;
    sourceProfileId?: string;
    version?: number;
  };
  outcome: {
    record?: MemoryRecord;
    result?: { status?: string; hash?: string; blobId?: string };
  } | null;
  sync_status?: string;
  durable_reference?: string;
  receipt?: { status?: string; hash?: string; blobId?: string };
  current_version?: number;
  current_status?: string;
}
export function auditInventoryRows(
  rows: readonly InventoryRow[],
  userId: string,
) {
  const records: MemoryRecord[] = [];
  const verified = new Set<string>();
  const verifiedSources = new Set<string>();
  let rejectedRecords = 0;
  const keys = new Set<string>();
  for (const row of rows) {
    const r = row.outcome?.record;
    const p = lessonVersionSchema.safeParse(r?.payload);
    let source: ReturnType<typeof validateSourceScore> | undefined;
    if (r?.type === "source_credibility")
      try {
        source = validateSourceScore(r.payload);
      } catch {
        /* Reject forged scores. */
      }
    const validLesson =
      p.success &&
      r?.type === "lesson" &&
      p.data.userId === userId &&
      p.data.id === r.logicalId &&
      p.data.version === r.version &&
      r.logicalId === row.payload.lessonId;
    const validSource =
      source &&
      source.userId === userId &&
      source.id === r?.logicalId &&
      source.version === r?.version &&
      r?.logicalId === row.payload.sourceProfileId;
    if (
      row.user_id !== userId ||
      row.payload.memoryConsent !== true ||
      !r ||
      (!validLesson && !validSource) ||
      r.version !== row.payload.version ||
      !Number.isFinite(Date.parse(r.recordedAt))
    ) {
      rejectedRecords++;
      continue;
    }
    const key = `${r.logicalId}@${r.version}`;
    if (!keys.has(key)) {
      records.push(r);
      keys.add(key);
    }
    const hash = createHash("sha256")
      .update(canonicalMemory({ schema: 1, userId, ...r }))
      .digest("hex");
    const receipt = row.receipt,
      result = row.outcome?.result;
    if (
      row.sync_status === "verified" &&
      receipt?.status === "verified" &&
      result?.status === "verified" &&
      receipt.hash === hash &&
      result.hash === hash &&
      receipt.blobId === row.durable_reference &&
      result.blobId === row.durable_reference &&
      !!row.durable_reference
    )
      (r.type === "lesson" ? verified : verifiedSources).add(r.logicalId);
  }
  return {
    records,
    summary: {
      expectedRecords: records.length,
      verifiedDistinctLessons: verified.size,
      verifiedDistinctSources: verifiedSources.size,
      rejectedRecords,
      completeness: "local_inventory_only" as const,
    },
  };
}
/** Read-only owned immutable outbox inventory. Remote content is never database authority. */
export async function readMemoryInventory(pool: Pool, userId: string) {
  const rows = await pool.query<InventoryRow>(
    `SELECT o.user_id,o.payload,o.outcome,m.sync_status,m.durable_reference,m.receipt FROM outbox o LEFT JOIN memory_records m ON m.logical_id=o.operation_key AND m.user_id=o.user_id WHERE o.user_id=$1 AND o.kind IN ('lesson.version.created','source.score.created') AND o.payload->'memoryConsent'='true'::jsonb ORDER BY o.created_at,o.operation_key LIMIT 501`,
    [userId],
  );
  const audit = auditInventoryRows(rows.rows.slice(0, 500), userId);
  return {
    ...audit,
    summary: { ...audit.summary, truncated: rows.rows.length > 500 },
  };
}
