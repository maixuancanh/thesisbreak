import { classifyConsolidation } from "../../agent/src/lesson-consolidation";
import { queueDependentReviews } from "./decision-dependencies";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  experienceSchema,
  candidateSchema,
  candidateReviewSchema,
  learningAtomSchema,
  type LearningCandidate,
} from "../../domain/src/experience-learning";
import { validateCandidateEvidence } from "../../domain/src/learning-evidence";
import { DomainConflict } from "../../domain/src/index";
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
async function transaction<T>(pool: Pool, run: (c: PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await run(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
async function request(
  c: PoolClient,
  userId: string,
  requestId: string,
  value: unknown,
) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([userId, requestId]),
  ]);
  const old = (
    await c.query(
      "SELECT request_hash,result FROM mutation_requests WHERE user_id=$1 AND request_id=$2",
      [userId, requestId],
    )
  ).rows[0];
  if (old && old.request_hash !== hash(value))
    throw new DomainConflict("IDEMPOTENCY_KEY_REUSED");
  return old?.result;
}
async function receipt(
  c: PoolClient,
  userId: string,
  requestId: string,
  value: unknown,
  result: unknown,
) {
  await c.query(
    "INSERT INTO mutation_requests(user_id,request_id,request_hash,result) VALUES($1,$2,$3,$4)",
    [userId, requestId, hash(value), JSON.stringify(result)],
  );
}
type LearningLease = {
  jobId: string;
  leaseToken: string;
  contextLookupOnly?: boolean;
};
async function fenceLease(
  c: PoolClient,
  userId: string,
  lease?: LearningLease,
) {
  if (!lease) return;
  const row = (
    await c.query(
      "SELECT id FROM learning_jobs WHERE id=$1 AND user_id=$2 AND lease_token=$3 AND state='processing' AND lease_until>clock_timestamp() FOR UPDATE",
      [lease.jobId, userId, lease.leaseToken],
    )
  ).rows[0];
  if (!row) throw new DomainConflict("LEARNING_LEASE_LOST");
}
export async function recordLearningExperience(
  pool: Pool,
  userId: string,
  value: unknown,
  lease?: LearningLease,
) {
  const input = experienceSchema.parse(value);
  return transaction(pool, async (c) => {
    await fenceLease(c, userId, lease);
    const operation = { op: "experience", ...input };
    const old = await request(c, userId, input.requestId, operation);
    if (old) return old;
    const run = (
      await c.query(
        "SELECT id,message,result,platform,native_id,clock_timestamp() AS known_at FROM agent_runs WHERE user_id=$1 AND id=$2 AND conversation_id=$3 AND status='completed' FOR SHARE",
        [userId, input.runId, input.sessionId],
      )
    ).rows[0];
    if (!run) throw Error("NOT_FOUND");
    const consent = (
      await c.query(
        "SELECT memory_consent FROM conversations WHERE user_id=$1 AND id=$2 FOR SHARE",
        [userId, input.sessionId],
      )
    ).rows[0];
    if (!consent?.memory_consent)
      throw new DomainConflict("MEMORY_CONSENT_REQUIRED");
    const id = randomUUID();
    await c.query(
      "INSERT INTO learning_experiences(id,user_id,request_id,request_hash,session_id,run_id,event_id,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        id,
        userId,
        input.requestId,
        hash(input),
        input.sessionId,
        input.runId,
        input.eventId,
        JSON.stringify(input),
      ],
    );
    for (const atom of input.atoms) {
      if (atom.eventId !== input.eventId)
        throw new DomainConflict("EVIDENCE_SCOPE_MISMATCH");
      if (Date.parse(atom.retrievedAt) > new Date(run.known_at).getTime())
        throw new DomainConflict("FUTURE_EVIDENCE");
      if (
        atom.origin === "user_statement" &&
        (atom.reference !== `${input.runId}:message` ||
          atom.text !== run.message)
      )
        throw new DomainConflict("ORIGINAL_MESSAGE_MISMATCH");
      if (atom.origin === "tool_result") {
        const originals = run.result?.learningEvidence;
        if (
          !atom.reference.startsWith(`${input.runId}:result:`) ||
          !Array.isArray(originals) ||
          !originals.some((e: unknown) => {
            if (!e || typeof e !== "object") return false;
            const source = e as Record<string, unknown>;
            return (
              typeof source.text === "string" &&
              source.origin !== "verified_outcome" &&
              source.text === atom.text &&
              (source.publishedAt ?? null) === atom.publishedAt &&
              (source.occurredAt ?? null) === atom.occurredAt &&
              source.retrievedAt === atom.retrievedAt &&
              source.sourceOrigin === atom.sourceOrigin &&
              (source.reference ?? `${input.runId}:result:${source.id}`) ===
                atom.reference
            );
          })
        )
          throw new DomainConflict("ORIGINAL_TOOL_RESULT_MISMATCH");
      }
      if (atom.origin === "verified_outcome") {
        const recapMatch = /^recap:([^:]+):(\d+)$/.exec(atom.reference);
        if (recapMatch) {
          const recap = (
            await c.query(
              `SELECT d.payload FROM decision_recap_versions d JOIN picks p ON p.id=d.pick_id AND p.user_id=d.user_id JOIN action_memory_preferences a ON a.user_id=d.user_id AND a.memory_consent=true WHERE d.user_id=$1 AND d.id=$2 AND d.revision=$3 AND d.mode='live' AND p.platform||':'||p.native_id=$4 AND d.revision=(SELECT max(x.revision) FROM decision_recap_versions x WHERE x.pick_id=d.pick_id AND x.user_id=d.user_id) FOR SHARE OF d,a`,
              [
                userId,
                recapMatch[1],
                Number(recapMatch[2]),
                `${run.platform}:${run.native_id}`,
              ],
            )
          ).rows[0];
          if (
            !recap ||
            recap.payload.officialResult?.status !== "final" ||
            JSON.stringify(recap.payload) !== atom.text
          )
            throw new DomainConflict("UNVERIFIED_SETTLEMENT_ORIGINAL");
        } else {
          const match = /^action:([^:]+):(\d+)$/.exec(atom.reference);
          if (!match) throw new DomainConflict("INVALID_SETTLEMENT_REFERENCE");
          await c.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [match[1]],
          );
          const outcome = (
            await c.query(
              `SELECT r.payload FROM confirmed_action_results r JOIN picks p ON p.id=r.pick_id AND p.user_id=r.user_id JOIN action_memory_preferences a ON a.user_id=r.user_id AND a.memory_consent=true WHERE r.user_id=$1 AND r.pick_id=$2 AND r.revision=$3 AND r.revision=(SELECT max(x.revision) FROM confirmed_action_results x WHERE x.pick_id=r.pick_id AND x.user_id=r.user_id) AND p.platform || ':' || p.native_id=$4 FOR SHARE OF r,a`,
              [
                userId,
                match[1],
                Number(match[2]),
                `${run.platform}:${run.native_id}`,
              ],
            )
          ).rows[0];
          if (
            !outcome ||
            outcome.payload.status !== "final" ||
            !outcome.payload.actions?.some(
              (a: { status: string }) => a.status === "observed_final",
            ) ||
            JSON.stringify(outcome.payload) !== atom.text
          )
            throw new DomainConflict("UNVERIFIED_SETTLEMENT_ORIGINAL");
        }
      }
      if (
        /(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|(?:api[_-]?key|password|private[_-]?key)\s*[:=]\s*["']?[^\s"']{8,})/i.test(
          atom.text,
        )
      )
        throw new DomainConflict("SENSITIVE_LEARNING_CONTENT");
      if (createHash("sha256").update(atom.text).digest("hex") !== atom.hash)
        throw new DomainConflict("EVIDENCE_HASH_MISMATCH");
      await c.query(
        "INSERT INTO memory_atoms(id,user_id,version,experience_id,hash,payload) VALUES($1,$2,$3,$4,$5,$6)",
        [atom.id, userId, atom.version, id, atom.hash, JSON.stringify(atom)],
      );
    }
    const result = { id, version: 1 };
    if (!lease?.contextLookupOnly)
      await c.query(
        "INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload) VALUES($1,$2,'extract',$3,$4) ON CONFLICT DO NOTHING",
        [
          randomUUID(),
          userId,
          id,
          JSON.stringify({
            ...result,
            immediate:
              run.result?.learningTrigger === "explicit_correction" ||
              /^(?:correction|đính chính|sửa lại)\s*:/iu.test(
                run.message.trim(),
              ) ||
              input.atoms.some((a) => a.origin === "verified_outcome"),
          }),
        ],
      );
    await receipt(c, userId, input.requestId, operation, result);
    return result;
  });
}
async function evidence(
  c: PoolClient,
  userId: string,
  input: LearningCandidate,
) {
  const sessions = (
    await c.query(
      "SELECT c.memory_consent FROM learning_experiences e JOIN conversations c ON c.id=e.session_id AND c.user_id=e.user_id WHERE e.user_id=$1 AND e.id=ANY($2) FOR SHARE OF c",
      [userId, input.experienceIds],
    )
  ).rows;
  if (sessions.some((s) => !s.memory_consent))
    throw new DomainConflict("MEMORY_CONSENT_REQUIRED");
  const rows = (
    await c.query(
      "SELECT payload,experience_id,withdrawn_at FROM memory_atoms WHERE user_id=$1 AND id=ANY($2) FOR SHARE",
      [userId, input.evidence.map((e) => e.atomId)],
    )
  ).rows.filter((row) =>
    input.evidence.some(
      (ref) =>
        ref.atomId === row.payload.id && ref.version === row.payload.version,
    ),
  );
  const atoms = rows.map((r) => learningAtomSchema.parse(r.payload));
  if (atoms.some((a) => a.origin === "verified_outcome")) {
    const consent = (
      await c.query(
        "SELECT memory_consent FROM action_memory_preferences WHERE user_id=$1 FOR SHARE",
        [userId],
      )
    ).rows[0];
    if (!consent?.memory_consent)
      throw new DomainConflict("MEMORY_CONSENT_REQUIRED");
  }
  for (const row of rows) {
    if (row.withdrawn_at) throw new DomainConflict("EVIDENCE_WITHDRAWN");
    if (!input.experienceIds.includes(row.experience_id))
      throw new DomainConflict("INVALID_EXPERIENCE_REFERENCE");
  }
  try {
    return validateCandidateEvidence(input, atoms);
  } catch (e) {
    throw new DomainConflict(
      e instanceof Error ? e.message : "INVALID_EVIDENCE_REFERENCE",
    );
  }
}
async function insertCandidate(
  c: PoolClient,
  userId: string,
  id: string,
  version: number,
  input: LearningCandidate,
) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify(["candidate-consolidation", userId]),
  ]);
  await evidence(c, userId, input);
  const previous = (
    await c.query(
      `SELECT c.id,c.version,c.payload,c.lesson_id,c.lesson_version,NOT EXISTS(SELECT 1 FROM lesson_candidate_evidence e JOIN memory_atoms a ON a.user_id=e.user_id AND a.id=e.atom_id AND a.version=e.atom_version WHERE e.user_id=c.user_id AND e.candidate_id=c.id AND e.candidate_version=c.version AND e.stance='support' AND a.withdrawn_at IS NOT NULL) AS support_active FROM lesson_candidates c WHERE c.user_id=$1 AND c.id<>$2 AND c.status IN ('pending_review','approved') ORDER BY c.recorded_at DESC,c.version DESC LIMIT 100`,
      [userId, id],
    )
  ).rows;
  const classified = classifyConsolidation(
    input,
    previous.map((r) => ({
      ...candidateSchema.parse(r.payload),
      id: r.id,
      supportActive: r.support_active,
    })),
  );
  const proposal = input.consolidationProposal;
  if (proposal) {
    const target = previous.find(
      (r) =>
        r.id === proposal.relatedId && r.version === proposal.relatedVersion,
    );
    if (!target) throw new DomainConflict("INVALID_CONSOLIDATION_REFERENCE");
    const prior = candidateSchema.parse(target.payload);
    const sameScope =
      JSON.stringify(prior.scope) === JSON.stringify(input.scope);
    if (
      prior.scope.domain !== input.scope.domain ||
      prior.scope.eventId !== input.scope.eventId ||
      (proposal.classification === "conflict" && !sameScope) ||
      (proposal.classification === "scope_change" && sameScope)
    )
      throw new DomainConflict("INVALID_CONSOLIDATION_SCOPE");
    if (
      proposal.relatedEvidence.some(
        (ref) =>
          !prior.evidence.some(
            (e) => JSON.stringify(e) === JSON.stringify(ref),
          ),
      )
    )
      throw new DomainConflict("INVALID_CONSOLIDATION_EVIDENCE");
    classified.classification = proposal.classification;
    classified.relatedId = proposal.relatedId;
    classified.requiresReview = true;
  }
  const related = previous.find((r) => r.id === classified.relatedId);
  const consolidation = {
    ...classified,
    relatedVersion: related?.version ?? null,
    ...(proposal
      ? {
          modelProposal: proposal,
          modelVersion: input.modelVersion,
          promptVersion: input.promptVersion,
        }
      : {}),
  };
  const experienceIds = (
    await c.query(
      "SELECT DISTINCT id FROM learning_experiences WHERE user_id=$1 AND id=ANY($2)",
      [userId, input.experienceIds],
    )
  ).rows;
  if (experienceIds.length !== new Set(input.experienceIds).size)
    throw new DomainConflict("INVALID_EXPERIENCE_REFERENCE");
  await c.query(
    "INSERT INTO lesson_candidates(id,user_id,version,request_id,request_hash,payload,supersedes_id,supersedes_version,consolidation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      id,
      userId,
      version,
      input.requestId,
      hash(input),
      JSON.stringify(input),
      input.supersedes?.id ?? null,
      input.supersedes?.version ?? null,
      JSON.stringify(consolidation),
    ],
  );
  for (const e of input.evidence)
    await c.query(
      "INSERT INTO lesson_candidate_evidence(user_id,candidate_id,candidate_version,atom_id,atom_version,hash,stance,quote) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [userId, id, version, e.atomId, e.version, e.hash, e.stance, e.quote],
    );
  if (
    related?.lesson_id &&
    ["conflict", "scope_change"].includes(consolidation.classification)
  ) {
    const deps = (
      await c.query(
        "SELECT DISTINCT dependency_version,dependency_hash FROM decision_dependencies WHERE user_id=$1 AND dependency_id=$2",
        [userId, related.lesson_id],
      )
    ).rows;
    for (const dep of deps)
      await queueDependentReviews(c, userId, {
        id: related.lesson_id,
        version: dep.dependency_version,
        hash: dep.dependency_hash,
        status: "pending_consolidation",
      });
  }
  return { id, version };
}
export async function createLessonCandidate(
  pool: Pool,
  userId: string,
  value: unknown,
  lease?: LearningLease,
) {
  const input = candidateSchema.parse(value);
  return transaction(pool, async (c) => {
    await fenceLease(c, userId, lease);
    const operation = { op: "candidate", ...input };
    const old = await request(c, userId, input.requestId, operation);
    if (old) return old;
    const result = await insertCandidate(c, userId, randomUUID(), 1, input);
    await receipt(c, userId, input.requestId, operation, result);
    return result;
  });
}
export async function listLearningCandidates(pool: Pool, userId: string) {
  return (
    await pool.query(
      `SELECT c.*,o.state AS sync_state,o.outcome AS sync_receipt FROM lesson_candidates c LEFT JOIN outbox o ON o.user_id=c.user_id AND o.kind='lesson.version.created' AND o.payload->>'lessonId'=c.lesson_id AND o.payload->>'version'=c.lesson_version::text WHERE c.user_id=$1 ORDER BY c.recorded_at DESC,c.version DESC LIMIT 100`,
      [userId],
    )
  ).rows;
}
export async function reviewLessonCandidate(
  pool: Pool,
  userId: string,
  id: string,
  value: unknown,
) {
  const input = candidateReviewSchema.parse(value);
  return transaction(pool, async (c) => {
    const operation = { op: "candidate.review", id, ...input };
    const old = await request(c, userId, input.requestId, operation);
    if (old) return old;
    const row = (
      await c.query(
        "SELECT * FROM lesson_candidates WHERE user_id=$1 AND id=$2 AND version=$3 FOR UPDATE",
        [userId, id, input.baseVersion],
      )
    ).rows[0];
    if (!row) throw Error("NOT_FOUND");
    if (row.status !== "pending_review")
      throw new DomainConflict("CANDIDATE_NOT_PENDING");
    const candidate = candidateSchema.parse(row.payload);
    let result: Record<string, unknown> = {
      id,
      version: input.baseVersion,
      status: "rejected",
    };
    if (input.action === "edit") {
      const edited = candidateSchema.parse({
        ...candidate,
        requestId: input.requestId,
        statement: input.statement,
        scope: input.scope,
        condition: input.condition,
        supersedes: { id, version: input.baseVersion },
      });
      await c.query(
        "UPDATE lesson_candidates SET status='superseded' WHERE user_id=$1 AND id=$2 AND version=$3",
        [userId, id, input.baseVersion],
      );
      result = {
        ...(await insertCandidate(
          c,
          userId,
          id,
          input.baseVersion + 1,
          edited,
        )),
        status: "pending_review",
      };
    } else if (input.action === "reject")
      await c.query(
        "UPDATE lesson_candidates SET status='rejected' WHERE user_id=$1 AND id=$2 AND version=$3",
        [userId, id, input.baseVersion],
      );
    else {
      if (
        ["conflict", "scope_change"].includes(
          row.consolidation?.classification,
        ) &&
        input.acknowledgeConflict !== true
      )
        throw new DomainConflict("CONSOLIDATION_REVIEW_REQUIRED");
      await evidence(c, userId, candidate);
      if (candidate.kind === "forecast_hypothesis")
        throw new DomainConflict("FORECAST_HYPOTHESIS_NOT_POLICY");
      const checkedAt = (await c.query("SELECT clock_timestamp() AS at"))
        .rows[0].at;
      if (
        candidate.condition &&
        Date.parse(candidate.condition.expiresAt) <=
          new Date(checkedAt).getTime()
      )
        throw new DomainConflict("CONDITION_EXPIRED");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify(["learning-lesson-approval", userId]),
      ]);
      const count = (
        await c.query(
          "SELECT COUNT(*)::int AS count FROM lessons WHERE user_id=$1",
          [userId],
        )
      ).rows[0].count;
      if (count >= 500) throw new DomainConflict("LESSON_LIMIT_REACHED");
      const lessonId = randomUUID();
      await c.query("INSERT INTO lessons(id,user_id) VALUES($1,$2)", [
        lessonId,
        userId,
      ]);
      const insertedVersion = await c.query(
        "INSERT INTO lesson_versions(lesson_id,user_id,version,parent_version,rule,scope,approval,status,effective_at,expires_at,learning_condition,learning_scope) SELECT $1,$2,1,NULL,$3,$4,'approved','active',clock_timestamp(),$5,$6,$7 WHERE $5::timestamptz IS NULL OR $5::timestamptz>clock_timestamp() RETURNING version",
        [
          lessonId,
          userId,
          candidate.statement,
          JSON.stringify({
            domain: candidate.scope.domain,
            ...(candidate.scope.competition
              ? { competition: candidate.scope.competition }
              : {}),
          }),
          candidate.condition?.expiresAt ?? null,
          JSON.stringify(candidate.condition),
          JSON.stringify(candidate.scope),
        ],
      );
      if (insertedVersion.rowCount !== 1)
        throw new DomainConflict("CONDITION_EXPIRED");
      await c.query(
        "INSERT INTO outbox(operation_key,user_id,kind,payload) VALUES($1,$2,'lesson.version.created',$3)",
        [
          JSON.stringify(["lesson", lessonId, 1]),
          userId,
          JSON.stringify({ lessonId, version: 1, memoryConsent: true }),
        ],
      );
      await c.query(
        "UPDATE lesson_candidates SET status='approved',lesson_id=$4,lesson_version=1 WHERE user_id=$1 AND id=$2 AND version=$3",
        [userId, id, input.baseVersion, lessonId],
      );
      result = {
        id,
        version: input.baseVersion,
        status: "approved",
        lessonId,
        lessonVersion: 1,
      };
    }
    await receipt(c, userId, input.requestId, operation, result);
    return result;
  });
}
