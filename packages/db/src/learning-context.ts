import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { recordLearningExperience } from "./experience-learning";
import { redactLearningSecrets } from "../../agent/src/experience-extractor";
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const uuid = (text: string) => {
  const h = digest(text);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
/** Exact preceding originals only; no later turn, foreign event, redacted quote or injected memory is expanded. */
export async function expandLearningContext(
  pool: Pool,
  input: {
    ownerId: string;
    jobId: string;
    leaseToken: string;
    sessionId: string;
    eventId: string;
    runIds: string[];
    knownAt: string;
    existingExperienceIds: string[];
  },
) {
  const rows = (
    await pool.query(
      `SELECT r.* FROM agent_runs r JOIN conversations co ON co.id=r.conversation_id AND co.user_id=r.user_id WHERE r.user_id=$1 AND r.conversation_id=$2 AND co.memory_consent=true AND r.status='completed'
 AND COALESCE(r.result->>'learningEventId',r.platform||':'||r.native_id)=$3 AND r.finished_at<=$4::timestamptz
 AND r.finished_at<=(SELECT min(a.created_at) FROM agent_runs a WHERE a.user_id=$1 AND a.id=ANY($5))
 ORDER BY r.finished_at DESC,r.id DESC LIMIT 2`,
      [
        input.ownerId,
        input.sessionId,
        input.eventId,
        input.knownAt,
        input.runIds,
      ],
    )
  ).rows;
  const experiences: { id: string; experience: unknown }[] = [];
  const omitted: { runId: string; reason: string }[] = [];
  for (const run of rows) {
    if (
      typeof run.message !== "string" ||
      run.message.length > 4000 ||
      run.message.includes("[REDACTED]") ||
      redactLearningSecrets(run.message) !== run.message
    ) {
      omitted.push({ runId: run.id, reason: "UNSAFE_OR_OVERSIZED_ORIGINAL" });
      continue;
    }
    const old = (
      await pool.query(
        "SELECT id,payload FROM learning_experiences WHERE user_id=$1 AND run_id=$2 AND event_id=$3 ORDER BY recorded_at,id LIMIT 1",
        [input.ownerId, run.id, input.eventId],
      )
    ).rows[0];
    if (old) {
      if (!input.existingExperienceIds.includes(old.id))
        experiences.push({ id: old.id, experience: old.payload });
      continue;
    }
    const at = new Date(run.finished_at).toISOString();
    const experience = {
      requestId: uuid(`context-experience:${run.id}`),
      sessionId: input.sessionId,
      runId: run.id,
      eventId: input.eventId,
      modelVersion: run.result?.modelVersion ?? "unknown",
      promptVersion: run.result?.promptVersion ?? "unknown",
      prerequisites: [],
      outcome: null,
      atoms: [
        {
          id: uuid(`context-atom:${run.id}`),
          origin: "user_statement",
          reference: `${run.id}:message`,
          version: 1,
          hash: digest(run.message),
          text: run.message,
          eventId: input.eventId,
          publishedAt: null,
          occurredAt: at,
          retrievedAt: at,
          sourceOrigin: `user:${input.ownerId}`,
        },
      ],
    };
    const saved = await recordLearningExperience(
      pool,
      input.ownerId,
      experience,
      {
        jobId: input.jobId,
        leaseToken: input.leaseToken,
        contextLookupOnly: true,
      },
    );
    experiences.push({ id: saved.id, experience });
  }
  return {
    experiences,
    omitted,
    checkedRuns: rows.map((r) => r.id),
    maxOriginalRuns: 2,
  };
}
