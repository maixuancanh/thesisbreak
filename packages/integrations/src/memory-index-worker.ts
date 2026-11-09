import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { loadCurrentApprovedLessons } from "../../db/src/approved-lessons";
import { rebuildMemoryIndex } from "../../db/src/memory-index";
import { syncGraphitiMemoryIndex } from "./graphiti-bridge";
import {
  approvedLessonEdges,
  APPROVED_LESSON_INDEX_NAMESPACE,
} from "../../domain/src/approved-lesson-index";
/** One owner's bounded derived refresh. No remote writes, extraction model, or new authority. */
export async function materializeApprovedLessonIndex(
  pool: Pool,
  ownerId: string,
) {
  const materializedAt = (
    await pool.query("SELECT clock_timestamp() AS at")
  ).rows[0].at.toISOString();
  const current = await loadCurrentApprovedLessons(pool, ownerId);
  const rows = (
    await pool.query(
      `SELECT o.outcome,m.receipt,m.durable_reference FROM outbox o
    JOIN memory_records m ON m.logical_id=o.operation_key AND m.user_id=o.user_id
    WHERE o.user_id=$1 AND o.kind='lesson.version.created' AND o.state='done'
    AND o.payload->'memoryConsent'='true'::jsonb AND m.sync_status='verified'
    AND o.payload->>'lessonId'=ANY($2::text[]) ORDER BY o.created_at DESC LIMIT 200`,
      [ownerId, current.map((l) => l.id)],
    )
  ).rows;
  const events = (
    await pool.query(
      `SELECT lc.lesson_id,lc.lesson_version,le.event_id,le.id AS experience_id,le.version AS experience_version,r.platform,r.native_id,r.result,r.finished_at
    FROM lesson_candidates lc CROSS JOIN LATERAL jsonb_array_elements_text(lc.payload->'experienceIds') x(id)
    JOIN learning_experiences le ON le.id=x.id AND le.user_id=lc.user_id
    JOIN conversations co ON co.id=le.session_id AND co.user_id=le.user_id AND co.memory_consent=true
    JOIN agent_runs r ON r.id=le.run_id AND r.user_id=le.user_id AND r.status='completed'
    WHERE lc.user_id=$1 AND lc.status='approved' AND lc.lesson_id=ANY($2::text[])
    ORDER BY lc.lesson_id,lc.lesson_version,le.id LIMIT 1000`,
      [ownerId, current.map((l) => l.id)],
    )
  ).rows;
  const edges = current.flatMap((lesson) =>
    rows.flatMap((row) => {
      const record = row.outcome?.record,
        receipt = row.receipt;
      if (
        !record ||
        record.logicalId !== lesson.id ||
        record.version !== lesson.version ||
        receipt?.blobId !== row.durable_reference ||
        !isDeepStrictEqual(row.outcome?.result, receipt)
      )
        return [];
      return approvedLessonEdges({
        lesson,
        materializedAt,
        record: { ...record, schema: 1, userId: ownerId, hash: receipt.hash },
        receipt,
        events: events
          .filter(
            (e) =>
              e.lesson_id === lesson.id && e.lesson_version === lesson.version,
          )
          .flatMap((e) => {
            if (
              e.result?.marketRef?.platform !== e.platform ||
              e.result?.marketRef?.nativeId !== e.native_id ||
              !Array.isArray(e.result.learningEvidence) ||
              !e.finished_at
            )
              return [];
            return e.result.learningEvidence.flatMap(
              (source: { id?: string; eventId?: string; text?: string }) => {
                if (
                  source.id !== "market-source" ||
                  source.eventId !== e.event_id ||
                  typeof source.text !== "string"
                )
                  return [];
                try {
                  const captured = JSON.parse(source.text);
                  return typeof captured.scheduledAt === "string"
                    ? [
                        {
                          provider: e.platform,
                          eventId: e.event_id,
                          scheduledAt: captured.scheduledAt,
                          evidenceId: `${e.experience_id}:v${e.experience_version}:market-source:sha256:${createHash("sha256").update(source.text).digest("hex")}`,
                          recordedAt: new Date(e.finished_at).toISOString(),
                        },
                      ]
                    : [];
                } catch {
                  return [];
                }
              },
            );
          }),
      });
    }),
  );
  // Repeated sessions may cite one immutable lesson/event. Consolidate provenance deterministically.
  const unique = new Map<string, (typeof edges)[number]>();
  for (const edge of edges) {
    const prior = unique.get(edge.id);
    if (!prior) unique.set(edge.id, edge);
    else
      unique.set(edge.id, {
        ...prior,
        evidenceIds: [...new Set([...prior.evidenceIds, ...edge.evidenceIds])]
          .sort()
          .slice(0, 100),
        availableAt: new Date(
          Math.max(Date.parse(prior.availableAt), Date.parse(edge.availableAt)),
        ).toISOString(),
      });
  }
  // Authority may change while provenance is read. Exclude changes before publishing the derived view.
  const fresh = await loadCurrentApprovedLessons(pool, ownerId);
  const result = await rebuildMemoryIndex(pool, {
    ownerId,
    namespace: APPROVED_LESSON_INDEX_NAMESPACE,
    edges: [...unique.values()].filter((e) =>
      fresh.some(
        (l) =>
          l.id === e.pointer.memoryId &&
          l.version === e.pointer.version &&
          current.some((old) => old.id === l.id && isDeepStrictEqual(old, l)),
      ),
    ),
  });
  const graphiti = await syncGraphitiMemoryIndex(
    pool,
    ownerId,
    APPROVED_LESSON_INDEX_NAMESPACE,
  );
  return { ...result, graphiti };
}
/** Fair cursor, one owner per leased maintenance invocation; includes stale-only owners for deletion. */
export async function runOneMemoryIndexMaterialization(pool: Pool) {
  const owner = (
    await pool.query(
      `WITH owners AS (SELECT user_id AS id FROM lessons UNION SELECT owner_id AS id FROM memory_index_edges WHERE namespace=$1), cursor AS (SELECT summary->>'ownerId' AS id FROM forecast_worker_health WHERE job='memory.index.materialize')
    SELECT id FROM owners ORDER BY CASE WHEN id>COALESCE((SELECT id FROM cursor),'') THEN 0 ELSE 1 END,id LIMIT 1`,
      [APPROVED_LESSON_INDEX_NAMESPACE],
    )
  ).rows[0]?.id;
  if (!owner) return { checked: 0, indexed: 0 };
  const result = await materializeApprovedLessonIndex(pool, owner);
  await pool.query(
    `INSERT INTO forecast_worker_health(job,last_success_at,summary) VALUES('memory.index.materialize',clock_timestamp(),$1) ON CONFLICT(job) DO UPDATE SET last_success_at=clock_timestamp(),summary=excluded.summary`,
    [JSON.stringify({ ownerId: owner, indexed: result.indexed })],
  );
  return { checked: 1, indexed: result.indexed };
}
