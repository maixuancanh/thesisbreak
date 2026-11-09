import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  answerClaimSchema,
  claimChallengeRevisionSchema,
  submitClaimChallengeSchema,
  withdrawClaimChallengeSchema,
  type ChallengeStatus,
} from "../../domain/src/claim-challenge";
import { monitoringTransaction } from "./pick-reasons";
import { appendExplanationReview } from "./explanation-reviews";
export const claimTextHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** Only explicit structured claims retained with a newly saved answer can be anchored. */
export async function saveAnswerClaims(
  pool: Pool,
  ownerId: string,
  messageId: string,
  claims: { claimId: string; claimText: string; evidenceIds: string[] }[],
) {
  if (claims.length > 20) throw Error("CLAIM_LIMIT");
  return monitoringTransaction(pool, ownerId, async (c) => {
    const run = (
      await c.query(
        "SELECT conversation_id,result FROM agent_runs WHERE user_id=$1 AND id=$2 AND status='completed' FOR UPDATE",
        [ownerId, messageId],
      )
    ).rows[0];
    if (!run) throw Error("NOT_FOUND");
    for (const input of claims) {
      // Metadata cannot validate itself: require an exact span and retained citation scope.
      if (
        typeof run.result?.reply?.message !== "string" ||
        !run.result.reply.message.includes(input.claimText)
      )
        throw Error("CLAIM_TEXT_MISMATCH");
      const scope = Array.isArray(run.result?.reply?.evidenceRefs)
        ? run.result.reply.evidenceRefs
        : [];
      if (input.evidenceIds.some((id) => !scope.includes(id)))
        throw Error("CLAIM_EVIDENCE_MISMATCH");
      const a = answerClaimSchema.parse({
        ownerId,
        sessionId: run.conversation_id,
        messageId,
        answerRevision: 1,
        ...input,
        claimTextHash: claimTextHash(input.claimText),
      });
      const old = (
        await c.query(
          "SELECT claim_text_hash FROM answer_claims WHERE user_id=$1 AND message_id=$2 AND answer_revision=1 AND claim_id=$3",
          [ownerId, messageId, a.claimId],
        )
      ).rows[0];
      if (old && old.claim_text_hash !== a.claimTextHash)
        throw Error("CLAIM_CONFLICT");
      await c.query(
        "INSERT INTO answer_claims(user_id,session_id,message_id,answer_revision,claim_id,claim_text_hash,claim_text,evidence_ids) VALUES($1,$2,$3,1,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
        [
          ownerId,
          a.sessionId,
          messageId,
          a.claimId,
          a.claimTextHash,
          a.claimText,
          JSON.stringify(a.evidenceIds),
        ],
      );
    }
  });
}
export async function readClaimChallenge(
  pool: Pool,
  ownerId: string,
  id: string,
) {
  return monitoringTransaction(pool, ownerId, async (c) => {
    const row = (
      await c.query(
        "SELECT * FROM claim_challenges WHERE user_id=$1 AND id=$2",
        [ownerId, id],
      )
    ).rows[0];
    if (!row) throw Error("NOT_FOUND");
    const revisions = (
      await c.query(
        "SELECT payload FROM claim_challenge_revisions WHERE user_id=$1 AND challenge_id=$2 ORDER BY revision",
        [ownerId, id],
      )
    ).rows.map((r) => r.payload);
    return { ...row, revisions };
  });
}
async function affectExplanations(
  c: PoolClient,
  ownerId: string,
  challenge: {
    id: string;
    message_id: string;
    answer_revision: number;
    claim_id: string;
    current_revision: number;
  },
  status: ChallengeStatus,
  explanation: string,
  evidenceIds: string[],
) {
  const claim = (
    await c.query(
      "SELECT evidence_ids FROM answer_claims WHERE user_id=$1 AND message_id=$2 AND answer_revision=$3 AND claim_id=$4",
      [
        ownerId,
        challenge.message_id,
        challenge.answer_revision,
        challenge.claim_id,
      ],
    )
  ).rows[0];
  const refs = [
    `answer:${challenge.message_id}:${challenge.answer_revision}:${challenge.claim_id}`,
    ...(claim?.evidence_ids ?? []),
  ];
  const recaps = (
    await c.query(
      `SELECT DISTINCT ON (pick_id) pick_id FROM decision_recap_versions WHERE user_id=$1 AND payload->'evidenceRefs' ?| $2::text[] ORDER BY pick_id,revision DESC`,
      [ownerId, refs],
    )
  ).rows;
  for (const r of recaps) {
    await c.query(
      "SELECT id FROM picks WHERE user_id=$1 AND id=$2 FOR UPDATE",
      [ownerId, r.pick_id],
    );
    const previous = (
      await c.query(
        "SELECT payload FROM explanation_reviews WHERE user_id=$1 AND pick_id=$2 ORDER BY revision DESC LIMIT 1",
        [ownerId, r.pick_id],
      )
    ).rows[0];
    const ids = [
      ...new Set([...(previous?.payload.challengeIds ?? []), challenge.id]),
    ];
    const related = (
      await c.query(
        "SELECT status FROM claim_challenges WHERE user_id=$1 AND id=ANY($2::text[])",
        [ownerId, ids],
      )
    ).rows;
    const state = related.some((r) =>
      ["submitted", "checking", "needs_evidence"].includes(r.status),
    )
      ? "under_review"
      : related.some((r) => r.status === "accepted")
        ? "corrected"
        : "inconclusive";
    await appendExplanationReview(c, ownerId, r.pick_id, state, {
      challengeId: challenge.id,
      challengeIds: ids,
      dependencyRefs: refs.map((id) => ({
        id,
        revision: challenge.answer_revision,
      })),
      evidenceIds,
      summary: explanation,
    });
  }
}
export async function appendChallengeRevision(
  c: PoolClient,
  ownerId: string,
  challenge: {
    id: string;
    message_id: string;
    answer_revision: number;
    claim_id: string;
    current_revision: number;
  },
  status: ChallengeStatus,
  explanation: string,
  evidenceIds: string[] = [],
  correctionText: string | null = null,
  audit: unknown = null,
) {
  const revision = challenge.current_revision + 1;
  const payload = claimChallengeRevisionSchema.parse({
    challengeId: challenge.id,
    ownerId,
    revision,
    status,
    explanation,
    evidenceIds,
    correctionText,
    checkedAt: ["accepted", "not_supported", "needs_evidence"].includes(status)
      ? new Date().toISOString()
      : null,
  });
  await c.query(
    "INSERT INTO claim_challenge_revisions(id,user_id,challenge_id,revision,status,payload) VALUES($1,$2,$3,$4,$5,$6)",
    [
      randomUUID(),
      ownerId,
      challenge.id,
      revision,
      status,
      JSON.stringify({ revision: payload, verification: audit }),
    ],
  );
  await c.query(
    "UPDATE claim_challenges SET current_revision=$3,status=$4,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2",
    [ownerId, challenge.id, revision, status],
  );
  await affectExplanations(
    c,
    ownerId,
    challenge,
    status,
    explanation,
    evidenceIds,
  );
  return payload;
}
export async function submitClaimChallenge(
  pool: Pool,
  ownerId: string,
  raw: unknown,
) {
  const input = submitClaimChallengeSchema.parse(raw);
  return monitoringTransaction(pool, ownerId, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${ownerId}:challenge:${input.clientRequestId}`,
    ]);
    const old = (
      await c.query(
        "SELECT * FROM claim_challenges WHERE user_id=$1 AND client_request_id=$2",
        [ownerId, input.clientRequestId],
      )
    ).rows[0];
    if (old) {
      if (
        old.message_id !== input.messageId ||
        old.answer_revision !== input.answerRevision ||
        old.claim_id !== input.claimId ||
        old.explanation !== input.explanation ||
        JSON.stringify(old.evidence_urls) !== JSON.stringify(input.evidenceUrls)
      )
        throw Error("REQUEST_ID_REUSED");
      return old;
    }
    const anchor = (
      await c.query(
        `SELECT a.* FROM answer_claims a JOIN agent_runs r ON r.user_id=a.user_id AND r.id=a.message_id AND r.conversation_id=a.session_id WHERE a.user_id=$1 AND a.message_id=$2 AND a.answer_revision=$3 AND a.claim_id=$4 AND r.status='completed'`,
        [ownerId, input.messageId, input.answerRevision, input.claimId],
      )
    ).rows[0];
    if (!anchor) throw Error("NOT_FOUND");
    if (claimTextHash(anchor.claim_text) !== anchor.claim_text_hash)
      throw Error("CLAIM_TEXT_MISMATCH");
    const rate = (
      await c.query(
        "SELECT count(*)::int AS count FROM claim_challenges WHERE user_id=$1 AND created_at>clock_timestamp()-interval '1 hour'",
        [ownerId],
      )
    ).rows[0];
    if (rate.count >= 30) throw Error("CHALLENGE_LIMIT");
    const row = (
      await c.query(
        `INSERT INTO claim_challenges(id,user_id,session_id,message_id,answer_revision,claim_id,client_request_id,explanation,evidence_urls,status,current_revision,request_hash,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'submitted',1,$10,$11) RETURNING *`,
        [
          randomUUID(),
          ownerId,
          anchor.session_id,
          input.messageId,
          input.answerRevision,
          input.claimId,
          input.clientRequestId,
          input.explanation,
          JSON.stringify(input.evidenceUrls),
          claimTextHash(JSON.stringify(input)),
          JSON.stringify(input),
        ],
      )
    ).rows[0];
    await appendChallengeRevision(
      c,
      ownerId,
      { ...row, current_revision: 0 },
      "submitted",
      "Counterevidence submitted for verification.",
    );
    await c.query(
      "INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload) VALUES($1,$2,'claim_challenge',$3,$4) ON CONFLICT(user_id,kind,operation_key) DO NOTHING",
      [randomUUID(), ownerId, row.id, JSON.stringify({ challengeId: row.id })],
    );
    return { ...row, status: "submitted", current_revision: 1 };
  });
}
export async function withdrawClaimChallenge(
  pool: Pool,
  ownerId: string,
  id: string,
  raw: unknown,
) {
  const input = withdrawClaimChallengeSchema.parse(raw);
  return monitoringTransaction(pool, ownerId, async (c) => {
    const row = (
      await c.query(
        "SELECT * FROM claim_challenges WHERE user_id=$1 AND id=$2 FOR UPDATE",
        [ownerId, id],
      )
    ).rows[0];
    if (!row) throw Error("NOT_FOUND");
    if (row.current_revision !== input.expectedRevision)
      throw Error("REVISION_CONFLICT");
    if (["accepted", "not_supported", "withdrawn"].includes(row.status))
      throw Error("CHALLENGE_CLOSED");
    return appendChallengeRevision(
      c,
      ownerId,
      row,
      "withdrawn",
      "Withdrawn by the account owner.",
    );
  });
}

export async function listMessageClaimChallenges(
  pool: Pool,
  ownerId: string,
  messageId: string,
) {
  return monitoringTransaction(pool, ownerId, async (c) => {
    if (
      !(
        await c.query(
          "SELECT id FROM agent_runs WHERE user_id=$1 AND id=$2 AND status='completed'",
          [ownerId, messageId],
        )
      ).rowCount
    )
      throw Error("NOT_FOUND");
    const claims = (
      await c.query(
        'SELECT claim_id AS "claimId",claim_text AS "claimText",answer_revision AS "answerRevision" FROM answer_claims WHERE user_id=$1 AND message_id=$2 ORDER BY answer_revision,claim_id LIMIT 20',
        [ownerId, messageId],
      )
    ).rows;
    const challenges = (
      await c.query(
        'SELECT cc.id,cc.claim_id AS "claimId",cc.status,cc.current_revision AS "currentRevision",cr.payload AS latest FROM claim_challenges cc LEFT JOIN claim_challenge_revisions cr ON cr.user_id=cc.user_id AND cr.challenge_id=cc.id AND cr.revision=cc.current_revision WHERE cc.user_id=$1 AND cc.message_id=$2 ORDER BY cc.created_at DESC LIMIT 50',
        [ownerId, messageId],
      )
    ).rows;
    return { claims, challenges };
  });
}
