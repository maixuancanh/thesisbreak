import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  sourceSnapshotHash,
  sourceSnapshotSchema,
  sourceWatchInputSchema,
  type SourceWatchInput,
} from "../../domain/src/source-watch";

export async function createSourceWatch(
  pool: Pool,
  ownerId: string,
  input: SourceWatchInput,
  options: { cap?: number; serviceWatchId?: string } = {},
) {
  const v = sourceWatchInputSchema.parse(input);
  const cap = options.cap ?? 5;
  if (!Number.isInteger(cap) || cap < 1 || cap > 25)
    throw Error("INVALID_WATCH_CAP");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.user_id',$1,true)",[ownerId]);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `source-watch:${ownerId}`,
    ]);
    const end = new Date(Date.parse(v.eventEndAt) + 86400000);
    const expiry = v.expiresAt ? new Date(v.expiresAt) : end;
    const count = (
      await c.query(
        "SELECT count(*)::int AS n,clock_timestamp() AS now FROM source_watches WHERE user_id=$1 AND state<>'deleted' AND expires_at>clock_timestamp()",
        [ownerId],
      )
    ).rows[0];
    if (count.n >= cap) throw Error("SOURCE_WATCH_CAP");
    if (expiry > end || expiry <= new Date(count.now))
      throw Error("SOURCE_WATCH_EXPIRY");
    const row = (
      await c.query(
        `INSERT INTO source_watches(id,user_id,event_id,url,origin_id,content_class,selector,dependency_id,hypothesis_version,expires_at,poll_seconds,service_watch_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          randomUUID(),
          ownerId,
          v.eventId,
          v.url,
          v.originId,
          v.contentClass,
          v.selector,
          v.dependencyId,
          v.hypothesisVersion,
          expiry,
          v.pollSeconds,
          options.serviceWatchId ?? null,
        ],
      )
    ).rows[0];
    await c.query("COMMIT");
    return row;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function listSourceWatches(
  pool: Pick<Pool, "query">,
  ownerId: string,
) {
  return (
    await pool.query(
      "SELECT * FROM source_watches WHERE user_id=$1 AND state<>'deleted' ORDER BY recorded_at DESC LIMIT 25",
      [ownerId],
    )
  ).rows;
}
export async function setSourceWatchState(
  pool: Pick<Pool, "query">,
  ownerId: string,
  watchId: string,
  state: "active" | "paused" | "deleted",
) {
  if (!["active", "paused", "deleted"].includes(state))
    throw Error("INVALID_WATCH_STATE");
  return (
    (
      await pool.query(
        "UPDATE source_watches SET state=$3,next_check_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND state<>'deleted' AND (expires_at>clock_timestamp() OR $3<>'active') RETURNING id,state",
        [watchId, ownerId, state],
      )
    ).rows[0] ?? null
  );
}
/** Called under a per-watch transaction lock; all inbound source claims are untrusted text. */
export async function recordSourceWatchSnapshot(
  pool: Pool,
  ownerId: string,
  watchId: string,
  raw: unknown,
  options: {
    structuredEvidence?: {
      subjectId: string;
      claimId?: string;
      eventId: string;
      official: boolean;
      lineupStatus?: "starter" | "not_starter";
      revision?: "corrected" | "withdrawn" | "original";
      sourceUrl: string;
      sourceHash: string;
      adapterVersion: string;
    };
  } = {},
) {
  const s = sourceSnapshotSchema.parse(raw),
    c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.user_id',$1,true)",[ownerId]);
    const w = (
      await c.query(
        "SELECT * FROM source_watches WHERE id=$1 AND user_id=$2 AND state='active' AND expires_at>clock_timestamp() FOR UPDATE",
        [watchId, ownerId],
      )
    ).rows[0];
    if (!w) {
      await c.query("COMMIT");
      return { status: "inactive" as const };
    }
    if (
      w.event_id !== s.eventId ||
      w.origin_id !== s.originId ||
      w.url !== s.url ||
      w.content_class !== s.contentClass
    )
      throw Error("SOURCE_IDENTITY_MISMATCH");
    const structured = options.structuredEvidence;
    if (
      structured &&
      (structured.eventId !== w.event_id ||
        structured.sourceUrl !== w.url ||
        (structured.adapterVersion === "nba-official-lineup-v1" &&
          !/^nba-player:[1-9][0-9]*$/.test(structured.subjectId)) ||
        !["nba-official-lineup-v1", "reviewed-report-revision-v1"].includes(
          structured.adapterVersion,
        ) ||
        !/^[a-f0-9]{64}$/.test(structured.sourceHash))
    )
      throw Error("STRUCTURED_SOURCE_IDENTITY_MISMATCH");
    const hash = sourceSnapshotHash(s.value),
      changed =
        w.snapshot_hash !== null &&
        (w.snapshot_hash !== hash || w.last_error !== null);
    const sequence = w.sequence + (changed ? 1 : 0);
    let changeId: string | null = null;
    if (changed) {
      changeId = randomUUID();
      await c.query(
        "INSERT INTO source_change_events(id,watch_id,user_id,before_hash,after_hash,sequence,before_value,after_value,published_at,after_structured_evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          changeId,
          watchId,
          ownerId,
          w.snapshot_hash,
          hash,
          sequence,
          w.snapshot_value,
          s.value,
          s.publishedAt,
          structured ? JSON.stringify(structured) : null,
        ],
      );
      await c.query(
        `INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload) SELECT $1,$2,'pick_impact',$3,$4 WHERE EXISTS(SELECT 1 FROM pick_watch_bindings b WHERE b.user_id=$2 AND b.watch_id=$5 AND b.state='active') ON CONFLICT(user_id,kind,operation_key) DO NOTHING`,
        [
          randomUUID(),
          ownerId,
          `pick-impact:${changeId}`,
          JSON.stringify({ changeId }),
          watchId,
        ],
      );
      // Existing consented dependency registrations alone may receive review work.
      const refs = (
        await c.query(
          "SELECT d.decision_id FROM decision_dependencies d WHERE d.user_id=$1 AND d.event_id=$2 AND d.dependency_id=$3 AND d.monitoring=true AND d.consent=true AND NOT EXISTS(SELECT 1 FROM change_proposals cp JOIN pick_reason_versions r ON r.pick_id=cp.pick_id AND r.user_id=cp.user_id JOIN pick_watch_bindings b ON b.reason_id=r.id AND b.user_id=r.user_id WHERE cp.id=d.decision_id AND cp.user_id=d.user_id AND b.watch_id=$4 AND b.state='active')",
          [ownerId, w.event_id, w.dependency_id, watchId],
        )
      ).rows;
      for (const ref of refs)
        await c.query(
          `INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload) VALUES($4,$1,'advice_review',$2,$3) ON CONFLICT DO NOTHING`,
          [
            ownerId,
            `source:${changeId}:${ref.decision_id}`,
            JSON.stringify({
              decisionId: ref.decision_id,
              eventId: w.event_id,
              dependencyId: w.dependency_id,
              version: w.hypothesis_version,
              hash,
              status: "superseded",
            }),
            randomUUID(),
          ],
        );
      if (refs.length)
        await c.query(
          `INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload) VALUES($4,$1,'dossier_dependency_change',$2,$3) ON CONFLICT DO NOTHING`,
          [
            ownerId,
            `source:${changeId}:dossier`,
            JSON.stringify({
              eventId: w.event_id,
              dependencyId: w.dependency_id,
              version: w.hypothesis_version,
              hash,
              status: "superseded",
            }),
            randomUUID(),
          ],
        );
    }
    await c.query(
      "UPDATE source_watches SET snapshot_hash=$3,snapshot_value=$4,published_at=$5,sequence=$6,last_success_at=clock_timestamp(),last_error=NULL,next_check_at=clock_timestamp()+poll_seconds*interval '1 second',structured_evidence=$7 WHERE id=$1 AND user_id=$2",
      [
        watchId,
        ownerId,
        hash,
        s.value,
        s.publishedAt,
        sequence,
        structured ? JSON.stringify(structured) : null,
      ],
    );
    await c.query("COMMIT");
    return {
      status:
        w.snapshot_hash === null
          ? ("baseline" as const)
          : changed
            ? ("changed" as const)
            : ("unchanged" as const),
      changeId,
      sequence,
    };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
/** Failed checks are immutable observations; unavailable never means contradicted. */
export async function recordSourceWatchFailure(
  pool: Pool,
  ownerId: string,
  watchId: string,
) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.user_id',$1,true)",[ownerId]);
    const w = (
      await c.query(
        "SELECT * FROM source_watches WHERE id=$1 AND user_id=$2 AND state='active' AND expires_at>clock_timestamp() FOR UPDATE",
        [watchId, ownerId],
      )
    ).rows[0];
    if (w && w.snapshot_hash && w.last_error === null) {
      const id = randomUUID(),
        sequence = w.sequence + 1;
      await c.query(
        "INSERT INTO source_change_events(id,watch_id,user_id,before_hash,after_hash,sequence,before_value,after_value,source_available) VALUES($1,$2,$3,$4,$4,$5,$6,$6,false)",
        [id, watchId, ownerId, w.snapshot_hash, sequence, w.snapshot_value],
      );
      await c.query(
        "UPDATE source_watches SET sequence=$3 WHERE id=$1 AND user_id=$2",
        [watchId, ownerId, sequence],
      );
      await c.query(
        "INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload) VALUES($1,$2,'pick_impact',$3,$4) ON CONFLICT DO NOTHING",
        [
          randomUUID(),
          ownerId,
          `pick-impact:${id}`,
          JSON.stringify({ changeId: id }),
        ],
      );
    }
    await c.query(
      "UPDATE source_watches SET last_error='SOURCE_CHECK_FAILED' WHERE id=$1 AND user_id=$2",
      [watchId, ownerId],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
