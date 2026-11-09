import type { Pool } from "pg";
import { learningSnapshotHash } from "../../agent/src/learning-provenance";
import { rememberedConditions } from "../../agent/src/remembered-conditions";
import { lessonRowToPayload, type LessonRow } from "./memory-outbox";
import {
  applyDossierPatch,
  dossierSchema,
  dependencySchema,
} from "../../agent/src/event-dossier";
/** Caller holds the event advisory lock. Only trusted database state may change protected blocks. */
export async function syncDossierDependency(
  client: Pick<Pool, "query">,
  userId: string,
  eventId: string,
  raw: unknown,
) {
  const changed = dependencySchema.parse(raw),
    old = await readEventDossier(client, userId, eventId, false);
  if (!old) return null;
  const aliases = new Set([
    changed.id,
    `lesson:${changed.id}`,
    `source:${changed.id}`,
    `evidence:${changed.id}`,
    `pick:${changed.id}`,
  ]);
  const next = dossierSchema.parse(old);
  let touched = false;
  for (const block of Object.values(next.blocks))
    for (const ref of block?.dependencies ?? [])
      if (aliases.has(ref.id)) {
        ref.status =
          changed.status === "current" ? "superseded" : changed.status;
        touched = true;
      }
  if (!touched) return null;
  const pickRef = next.blocks.savedView?.dependencies.find(
    (d) => d.id.startsWith("pick:") && aliases.has(d.id),
  );
  if (pickRef) {
    const row = (
      await client.query(
        "SELECT p.id,v.version,v.outcome,v.reason FROM picks p JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id AND v.version=p.current_version WHERE p.user_id=$1 AND p.id=$2 FOR SHARE OF p",
        [userId, pickRef.id.slice(5)],
      )
    ).rows[0];
    if (row) {
      const pick = {
        id: row.id,
        version: row.version,
        outcome: row.outcome,
        reason: row.reason,
      };
      const dependency = {
        id: pickRef.id,
        version: row.version,
        hash: learningSnapshotHash(pick),
        status: "current" as const,
      };
      next.blocks.savedView = {
        text: JSON.stringify(pick),
        dependencies: [dependency],
      };
      next.blocks.reasons = {
        text: row.reason ?? "No confirmed saved reason.",
        dependencies: [dependency],
      };
    }
  }
  const lessonRef = next.blocks.conditions?.dependencies.find(
    (d) => d.id.startsWith("lesson:") && aliases.has(d.id),
  );
  if (lessonRef && next.blocks.conditions) {
    const id = lessonRef.id.slice(7);
    const row = (
      await client.query(
        `SELECT v.*,o.state AS sync_state,o.payload->'memoryConsent' AS memory_consent,
        NOT EXISTS(SELECT 1 FROM lesson_candidates lc JOIN lesson_candidate_evidence e ON e.user_id=lc.user_id AND e.candidate_id=lc.id AND e.candidate_version=lc.version JOIN memory_atoms a ON a.user_id=e.user_id AND a.id=e.atom_id AND a.version=e.atom_version WHERE lc.user_id=l.user_id AND lc.lesson_id=l.id AND lc.lesson_version=v.version AND e.stance='support' AND (a.withdrawn_at IS NOT NULL OR (a.payload->>'origin'='verified_outcome' AND NOT EXISTS(SELECT 1 FROM action_memory_preferences ap WHERE ap.user_id=l.user_id AND ap.memory_consent=true))))
        AND NOT EXISTS(SELECT 1 FROM lesson_candidates lc CROSS JOIN LATERAL jsonb_array_elements_text(lc.payload->'experienceIds') x(id) JOIN learning_experiences le ON le.user_id=lc.user_id AND le.id=x.id JOIN conversations co ON co.user_id=le.user_id AND co.id=le.session_id WHERE lc.user_id=l.user_id AND lc.lesson_id=l.id AND lc.lesson_version=v.version AND co.memory_consent=false) AS support_active
        FROM lessons l JOIN lesson_versions v ON v.lesson_id=l.id AND v.user_id=l.user_id AND v.version=l.current_version LEFT JOIN outbox o ON o.user_id=l.user_id AND o.kind='lesson.version.created' AND o.payload->>'lessonId'=l.id AND o.payload->>'version'=l.current_version::text WHERE l.user_id=$1 AND l.id=$2 FOR SHARE OF l`,
        [userId, id],
      )
    ).rows[0];
    const previous = JSON.parse(next.blocks.conditions.text) as {
      id: string;
    }[];
    if (!Array.isArray(previous)) throw Error("INVALID_CONFIRMED_CONDITIONS");
    const remaining = previous.filter((c) => c.id !== id);
    if (row) {
      const lesson = lessonRowToPayload(row as LessonRow),
        now = (await client.query("SELECT clock_timestamp() AS now")).rows[0]
          .now as Date;
      const applied =
        row.sync_state === "done" &&
        row.memory_consent === true &&
        row.support_active === true &&
        changed.status === "current"
          ? rememberedConditions({
              userId,
              domain: lesson.scope.domain,
              ...(lesson.scope.competition
                ? { competition: lesson.scope.competition }
                : {}),
              ...(lesson.learningScope?.marketType
                ? { marketType: lesson.learningScope.marketType }
                : {}),
              ...(lesson.learningScope?.horizon
                ? { horizon: lesson.learningScope.horizon }
                : {}),
              eventId,
              now,
              lessons: [lesson],
            }).applied
          : [];
      next.blocks.conditions.text = JSON.stringify([...remaining, ...applied]);
      next.blocks.conditions.dependencies =
        next.blocks.conditions.dependencies.map((ref) =>
          ref.id === lessonRef.id
            ? {
                id: ref.id,
                version: lesson.version,
                hash: learningSnapshotHash(lesson),
                status: applied.length
                  ? "current"
                  : changed.status === "current"
                    ? "pending_consolidation"
                    : changed.status,
              }
            : ref,
        );
    } else next.blocks.conditions.text = JSON.stringify(remaining);
  }
  const checked = (await client.query("SELECT clock_timestamp() AS now"))
    .rows[0].now;
  next.checkedAt = new Date(checked).toISOString();
  next.revision = old.revision + 1;
  const validated = dossierSchema.parse(next);
  await client.query(
    "INSERT INTO event_dossier_versions(user_id,event_id,revision,payload) VALUES($1,$2,$3,$4)",
    [userId, eventId, validated.revision, JSON.stringify(validated)],
  );
  return validated;
}
export async function readEventDossier(
  pool: Pick<Pool, "query">,
  userId: string,
  eventId: string,
  includePending = true,
) {
  const row = (
    await pool.query(
      "SELECT payload FROM event_dossier_versions WHERE user_id=$1 AND event_id=$2 ORDER BY revision DESC LIMIT 1",
      [userId, eventId],
    )
  ).rows[0];
  if (!row) return null;
  const dossier = dossierSchema.parse(row.payload);
  if (includePending) {
    const pending = (
      await pool.query(
        "SELECT payload FROM learning_jobs WHERE user_id=$1 AND kind='dossier_dependency_change' AND payload->>'eventId'=$2 AND state<>'completed' ORDER BY recorded_at",
        [userId, eventId],
      )
    ).rows;
    for (const job of pending) {
      const change = dependencySchema.parse({
        id: job.payload.dependencyId,
        version: job.payload.version,
        hash: job.payload.hash,
        status: job.payload.status,
      });
      const aliases = new Set([
        change.id,
        `lesson:${change.id}`,
        `source:${change.id}`,
        `evidence:${change.id}`,
        `pick:${change.id}`,
      ]);
      for (const block of Object.values(dossier.blocks))
        for (const ref of block?.dependencies ?? [])
          if (aliases.has(ref.id))
            ref.status =
              change.status === "current"
                ? "pending_consolidation"
                : change.status;
    }
  }
  return dossier;
}
/** Initial savedView/conditions must come from a trusted confirmed-state builder, not model output. */
export async function createEventDossier(
  pool: Pick<Pool, "query">,
  userId: string,
  input: unknown,
) {
  const dossier = dossierSchema.parse(input);
  if (dossier.ownerId !== userId) throw Error("FORBIDDEN");
  if (dossier.revision !== 1) throw Error("INITIAL_REVISION_REQUIRED");
  await pool.query(
    "INSERT INTO event_dossier_versions(user_id,event_id,revision,payload) VALUES($1,$2,1,$3)",
    [userId, dossier.eventId, JSON.stringify(dossier)],
  );
  return dossier;
}
export async function patchEventDossier(
  pool: Pool,
  userId: string,
  eventId: string,
  input: unknown,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `dossier:${userId}:${eventId}`,
    ]);
    const current = await readEventDossier(client, userId, eventId);
    if (!current) throw Error("NOT_FOUND");
    const dossier = applyDossierPatch(current, input);
    await client.query(
      "INSERT INTO event_dossier_versions(user_id,event_id,revision,payload) VALUES($1,$2,$3,$4)",
      [userId, eventId, dossier.revision, JSON.stringify(dossier)],
    );
    await client.query("COMMIT");
    return dossier;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
