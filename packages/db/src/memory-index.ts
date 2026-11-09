import type { Pool } from "pg";
import {
  memoryEdgeSchema,
  memoryIndexQuerySchema,
  rankMemoryEdges,
  type MemoryEdge,
  type MemoryIndexQuery,
} from "../../domain/src/memory-index";

/** Caller supplies a server-authorized owner/namespace. Never accepts extracted claims as approval. */
export async function rebuildMemoryIndex(
  pool: Pool,
  input: { ownerId: string; namespace: string; edges: unknown[] },
) {
  if (
    !input.ownerId.trim() ||
    !input.namespace.trim() ||
    input.edges.length > 10000
  )
    throw Error("INVALID_INDEX_REBUILD");
  const unique = new Map<string, MemoryEdge>();
  const pointers = new Map<string, string>();
  for (const raw of input.edges) {
    const edge = memoryEdgeSchema.parse(raw);
    if (
      edge.pointer.ownerId !== input.ownerId ||
      edge.namespace !== input.namespace
    )
      throw Error("INDEX_OWNER_NAMESPACE_MISMATCH");
    const existing = unique.get(edge.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(edge))
      throw Error("INDEX_EDGE_CONFLICT");
    const identity = JSON.stringify([
      edge.pointer.memoryId,
      edge.pointer.version,
    ]);
    const digest = JSON.stringify([edge.pointer.sha256, edge.pointer.blobId]);
    if (pointers.has(identity) && pointers.get(identity) !== digest)
      throw Error("INDEX_POINTER_CONFLICT");
    pointers.set(identity, digest);
    unique.set(edge.id, edge);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([input.ownerId, input.namespace]),
    ]);
    await client.query(
      "DELETE FROM memory_index_edges WHERE owner_id=$1 AND namespace=$2",
      [input.ownerId, input.namespace],
    );
    for (const edge of [...unique.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      await client.query(
        `INSERT INTO memory_index_edges(owner_id,namespace,edge_id,memory_id,memory_version,memory_sha256,blob_id,event_provider,event_native_id,event_date,recorded_at,available_at,valid_from,valid_to,trusted,edge)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          input.ownerId,
          input.namespace,
          edge.id,
          edge.pointer.memoryId,
          edge.pointer.version,
          edge.pointer.sha256,
          edge.pointer.blobId,
          edge.event.provider,
          edge.event.nativeId,
          edge.event.date,
          edge.recordedAt,
          edge.availableAt,
          edge.validFrom,
          edge.validTo,
          edge.trusted,
          edge,
        ],
      );
    }
    await client.query("COMMIT");
    return { indexed: unique.size, namespace: input.namespace };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Direct search dependency for retrieveGraphContext. All scope/time filters precede ranking. */
export function createPostgresMemoryIndex(pool: Pool) {
  return async (raw: MemoryIndexQuery) => {
    const q = memoryIndexQuerySchema.parse(raw);
    const terms = [
      ...new Set(q.query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
    ];
    const result = await pool.query(
      `WITH scoped AS (
      SELECT edge,edge_id FROM memory_index_edges WHERE owner_id=$1 AND namespace=$2
      AND event_provider=$3 AND event_native_id=$4 AND event_date=$5::date AND trusted
      AND recorded_at<=$6::timestamptz AND available_at<=$6::timestamptz AND valid_from<=$6::timestamptz
      AND (valid_to IS NULL OR valid_to>$6::timestamptz)
      AND NOT EXISTS(SELECT 1 FROM jsonb_each_text(COALESCE(edge->'scope','{}'::jsonb)) AS scope WHERE ($9::jsonb->>scope.key) IS DISTINCT FROM scope.value)
    ), ranked AS (
      SELECT edge,edge_id,
      (SELECT count(*) FROM unnest($7::text[]) AS term WHERE strpos(lower(edge->>'text'),term)>0)
      + 2*(SELECT count(*) FROM jsonb_array_elements(edge->'entities') AS entity WHERE $8::jsonb @> jsonb_build_array(entity)) AS score
      FROM scoped
    ) SELECT edge FROM ranked WHERE score>0 ORDER BY score DESC,edge_id COLLATE "C" LIMIT 10000`,
      [
        q.ownerId,
        q.namespace,
        q.event.provider,
        q.event.nativeId,
        q.event.date,
        q.cutoffAt,
        terms,
        JSON.stringify(q.entities),
        JSON.stringify(q.scope ?? {}),
      ],
    );
    // Defense in depth against stale/malformed rows. Stable JS tie order matches the reference adapter.
    return rankMemoryEdges(
      q,
      result.rows.map((row) => row.edge),
    );
  };
}

export async function invalidateMemoryIndex(
  pool: Pool,
  input: { ownerId: string; namespace: string; memoryId: string },
) {
  if (!input.ownerId || !input.namespace || !input.memoryId)
    throw Error("INVALID_INDEX_INVALIDATION");
  const result = await pool.query(
    "DELETE FROM memory_index_edges WHERE owner_id=$1 AND namespace=$2 AND memory_id=$3",
    [input.ownerId, input.namespace, input.memoryId],
  );
  return result.rowCount ?? 0;
}
