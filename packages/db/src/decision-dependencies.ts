import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  dependencySchema,
  type DecisionDependency,
} from "../../agent/src/event-dossier";
/** Caller supplies its existing decision transaction so advice and dependencies commit together. */
export async function recordDecisionDependencies(
  client: Pick<PoolClient, "query">,
  input: {
    userId: string;
    decisionId: string;
    eventId: string;
    monitoring: boolean;
    consent: boolean;
    dependencies: DecisionDependency[];
  },
) {
  if (input.dependencies.length > 100) throw Error("DEPENDENCY_LIMIT");
  if (
    new Set(input.dependencies.map((d) => d.id)).size !==
    input.dependencies.length
  )
    throw Error("DUPLICATE_DEPENDENCY");
  for (const raw of input.dependencies) {
    const d = dependencySchema.parse(raw);
    await client.query(
      "INSERT INTO decision_dependencies(user_id,decision_id,event_id,dependency_id,dependency_version,dependency_hash,dependency_status,monitoring,consent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        input.userId,
        input.decisionId,
        input.eventId,
        d.id,
        d.version,
        d.hash,
        d.status,
        input.monitoring,
        input.consent,
      ],
    );
  }
}
/** Duplicate evidence notifications enqueue at most one job per decision and exact changed version/status. */
export async function queueDependentReviews(
  pool: Pick<Pool, "query">,
  userId: string,
  raw: DecisionDependency,
  options: { stage?: "changed" | "verified"; eventId?: string } = {},
) {
  const d = dependencySchema.parse(raw);
  // Dossiers use typed prefixes; proposal dependencies retain native record IDs.
  const aliases = [
    ...new Set([
      d.id,
      `lesson:${d.id}`,
      `source:${d.id}`,
      `evidence:${d.id}`,
      `pick:${d.id}`,
    ]),
  ];
  await pool.query(
    `INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload)
 SELECT gen_random_uuid()::text,v.user_id,'dossier_dependency_change',v.event_id||':'||$3||':'||$4::text||':'||$5||':'||$6||':'||$7,
 jsonb_build_object('eventId',v.event_id,'dependencyId',$3::text,'version',$4::integer,'hash',$5::text,'status',$6::text)
 FROM event_dossier_versions v WHERE v.user_id=$1 AND ($8::text IS NULL OR v.event_id=$8) AND v.revision=(SELECT max(x.revision) FROM event_dossier_versions x WHERE x.user_id=v.user_id AND x.event_id=v.event_id)
 AND EXISTS(SELECT 1 FROM jsonb_each(v.payload->'blocks') b CROSS JOIN LATERAL jsonb_array_elements(b.value->'dependencies') d WHERE d->>'id'=ANY($2::text[]) AND ((d->>'version')::integer<>$4::integer OR d->>'hash'<>$5 OR d->>'status'<>'current' OR $6<>'current'))
 ON CONFLICT(user_id,kind,operation_key) DO NOTHING`,
    [
      userId,
      aliases,
      d.id,
      d.version,
      d.hash,
      d.status,
      options.stage ?? "changed",
      options.eventId ?? null,
    ],
  );
  const result = await pool.query(
    `INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload)
 SELECT $1||':'||decision_id,user_id,'advice_review',decision_id||':'||$3||':'||$4||':'||$5||':'||$6,
 jsonb_build_object('decisionId',decision_id,'eventId',event_id,'dependencyId',dependency_id,'version',$4::integer,'hash',$5::text,'status',$6::text)
 FROM decision_dependencies WHERE user_id=$2 AND dependency_id=ANY($7::text[]) AND ($8::text IS NULL OR event_id=$8) AND monitoring AND consent
 AND (dependency_version<>$4::integer OR dependency_hash<>$5 OR $6<>'current')
 ON CONFLICT(user_id,kind,operation_key) DO NOTHING RETURNING id`,
    [
      randomUUID(),
      userId,
      d.id,
      d.version,
      d.hash,
      d.status,
      aliases,
      options.eventId ?? null,
    ],
  );
  return result.rows.map((r) => r.id as string);
}
/** Invalidate every approved rule supported by a withdrawn atom, not only advice that cited the raw atom. */
export async function propagateAtomWithdrawal(
  client: Pick<Pool, "query">,
  userId: string,
  atomId: string,
  status: DecisionDependency["status"] = "revoked",
) {
  const rows = (
    await client.query(
      `SELECT DISTINCT c.lesson_id,c.lesson_version,d.dependency_hash FROM lesson_candidate_evidence e JOIN lesson_candidates c ON c.user_id=e.user_id AND c.id=e.candidate_id AND c.version=e.candidate_version LEFT JOIN decision_dependencies d ON d.user_id=c.user_id AND d.dependency_id=c.lesson_id AND d.dependency_version=c.lesson_version WHERE e.user_id=$1 AND e.atom_id=$2 AND e.stance='support' AND c.lesson_id IS NOT NULL`,
      [userId, atomId],
    )
  ).rows;
  for (const row of rows)
    await queueDependentReviews(client, userId, {
      id: row.lesson_id,
      version: row.lesson_version,
      hash: row.dependency_hash ?? "0".repeat(64),
      status,
    });
}
