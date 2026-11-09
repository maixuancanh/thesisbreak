import { prepareLearningBatch } from "../../db/src/learning-batches";
import { expandLearningContext } from "../../db/src/learning-context";
import { reserveLearningExtraction } from "../../db/src/learning-budget";
import { claimLearningJob } from "../../db/src/learning-jobs";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import type { GenerateReply } from "../../agent/src/context";
import { parseLlmConfig } from "../../agent/src/context";
import { extractExperienceCandidates } from "../../agent/src/experience-extractor";
import {
  recordLearningExperience,
  createLessonCandidate,
} from "../../db/src/experience-learning";
import { redactLearningSecrets } from "../../agent/src/experience-extractor";
import { classifyConsolidation } from "../../agent/src/lesson-consolidation";
import { candidateSchema } from "../../domain/src/experience-learning";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function stableId(value: string) {
  const h = createHash("sha256").update(value).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** One bounded leased job; model failures retain retry state rather than losing a session. */
export async function runOneLearningJob(
  pool: Pool,
  env: Readonly<Record<string, string | undefined>> = process.env,
  generate?: GenerateReply,
  ownerId?: string,
) {
  const boundedSetting = (name: string, fallback: number, max: number) => {
    const raw = env[name];
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1 || n > max)
      throw Error("INVALID_LEARNING_BUDGET_CONFIG");
    return n;
  };
  const maxInputBytes = boundedSetting(
    "LEARNING_MAX_INPUT_BYTES",
    64000,
    100000,
  );
  const maxOutputTokens = boundedSetting(
    "LEARNING_MAX_OUTPUT_TOKENS",
    3500,
    3500,
  );
  const ownerDailyAttempts = boundedSetting(
    "LEARNING_OWNER_DAILY_ATTEMPTS",
    10,
    1000,
  );
  const globalDailyAttempts = boundedSetting(
    "LEARNING_DAILY_ATTEMPTS",
    100,
    10000,
  );
  const token = randomUUID();
  const job = await claimLearningJob(pool, {
    kinds: ["capture", "capture_settlement", "capture_recap", "extract"],
    token,
    leaseSeconds: 150,
    ownerId,
  });
  if (!job) return { checked: 0, completed: 0 };
  let incomplete = false;
  try {
    if (
      job.kind === "capture" ||
      job.kind === "capture_settlement" ||
      job.kind === "capture_recap"
    ) {
      const run = (
        await pool.query(
          `SELECT r.*,clock_timestamp() AS known_at FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id WHERE r.id=$1 AND r.user_id=$2 AND r.status='completed' AND c.memory_consent=true`,
          [job.payload.runId, job.user_id],
        )
      ).rows[0];
      if (run && redactLearningSecrets(run.message) === run.message) {
        const at = new Date(run.finished_at).toISOString(),
          eventId =
            run.result?.learningEventId ?? `${run.platform}:${run.native_id}`;
        const toolAtoms = (
          Array.isArray(run.result?.learningEvidence)
            ? run.result.learningEvidence
            : []
        )
          .flatMap((source: Record<string, unknown>) => {
            if (
              source.origin === "verified_outcome" ||
              typeof source.id !== "string" ||
              typeof source.text !== "string" ||
              source.text.length > 12000 ||
              redactLearningSecrets(source.text) !== source.text ||
              typeof source.retrievedAt !== "string" ||
              typeof source.sourceOrigin !== "string"
            )
              return [];
            return [
              {
                id: stableId(`atom:${job.id}:${run.id}:${source.id}`),
                origin: "tool_result" as const,
                reference: `${run.id}:result:${source.id}`,
                version: 1,
                hash: digest(source.text),
                text: source.text,
                eventId,
                publishedAt: source.publishedAt ?? null,
                occurredAt: source.occurredAt ?? null,
                retrievedAt: source.retrievedAt,
                sourceOrigin: source.sourceOrigin,
              },
            ];
          })
          .slice(0, 30);
        const settlement =
          job.kind === "capture_settlement"
            ? (
                await pool.query(
                  `SELECT r.* FROM confirmed_action_results r JOIN action_memory_preferences a ON a.user_id=r.user_id AND a.memory_consent=true WHERE r.user_id=$1 AND r.pick_id=$2 AND r.revision=$3`,
                  [job.user_id, job.payload.pickId, job.payload.revision],
                )
              ).rows[0]
            : null;
        if (
          job.kind === "capture_settlement" &&
          (!settlement ||
            settlement.payload.status !== "final" ||
            !settlement.payload.actions?.some(
              (a: { status: string }) => a.status === "observed_final",
            ))
        )
          throw new Error("SETTLEMENT_NOT_SCORABLE");
        const recap =
          job.kind === "capture_recap"
            ? (
                await pool.query(
                  `SELECT d.* FROM decision_recap_versions d JOIN action_memory_preferences a ON a.user_id=d.user_id AND a.memory_consent=true WHERE d.user_id=$1 AND d.id=$2 AND d.mode='live' AND d.revision=(SELECT max(x.revision) FROM decision_recap_versions x WHERE x.user_id=d.user_id AND x.pick_id=d.pick_id)`,
                  [job.user_id, job.payload.recapId],
                )
              ).rows[0]
            : null;
        if (
          job.kind === "capture_recap" &&
          (!recap ||
            recap.payload.officialResult?.status !== "final" ||
            JSON.stringify(recap.payload).length > 12000)
        )
          throw Error("SETTLEMENT_NOT_SCORABLE");
        const recapAtoms = recap
          ? [
              {
                id: stableId(`atom:recap:${recap.id}`),
                origin: "verified_outcome" as const,
                reference: `recap:${recap.id}:${recap.revision}`,
                version: recap.revision,
                hash: digest(JSON.stringify(recap.payload)),
                text: JSON.stringify(recap.payload),
                eventId,
                publishedAt: null,
                occurredAt: recap.payload.officialResult.observedAt,
                retrievedAt: new Date(recap.created_at).toISOString(),
                sourceOrigin: `unknown:recap:${recap.pick_id}`,
              },
            ]
          : [];
        const outcomeAtoms = settlement
          ? [
              {
                id: stableId(
                  `atom:settlement:${settlement.pick_id}:${settlement.revision}`,
                ),
                origin: "verified_outcome" as const,
                reference: `action:${settlement.pick_id}:${settlement.revision}`,
                version: 1,
                hash: digest(JSON.stringify(settlement.payload)),
                text: JSON.stringify(settlement.payload),
                eventId,
                publishedAt: null,
                occurredAt: null,
                retrievedAt: settlement.payload.retrievedAt,
                sourceOrigin: "kalshi-public",
              },
            ]
          : [];
        await recordLearningExperience(
          pool,
          job.user_id,
          {
            requestId: stableId(
              recap
                ? `capture:recap:${recap.id}`
                : job.kind === "capture_settlement"
                  ? `capture:settlement:${job.payload.pickId}:${job.payload.revision}`
                  : `capture:${run.id}`,
            ),
            sessionId: run.conversation_id,
            runId: run.id,
            eventId,
            modelVersion: run.result?.modelVersion ?? "unknown",
            promptVersion: run.result?.promptVersion ?? "unknown",
            prerequisites: recap
              ? [
                  "decision_recap",
                  `recap:${recap.id}:${recap.revision}`,
                  "single_event_observational",
                ]
              : [],
            outcome: recap
              ? "Verified decision chronology; outcome does not establish reasoning skill. One event, uncertainty remains."
              : settlement
                ? `Observed final result revision ${settlement.revision}; observational only, improvement not established`
                : null,
            atoms: [
              ...toolAtoms,
              ...outcomeAtoms,
              ...recapAtoms,
              {
                id: stableId(`atom:${job.id}:${run.id}`),
                origin: "user_statement",
                reference: `${run.id}:message`,
                version: 1,
                hash: digest(run.message),
                text: run.message,
                eventId,
                publishedAt: null,
                occurredAt: at,
                retrievedAt: at,
                sourceOrigin: `user:${job.user_id}`,
              },
            ],
          },
          { jobId: job.id, leaseToken: token },
        );
      }
    } else {
      const batch = await prepareLearningBatch(pool, job, token);
      if (batch.deferred) return { checked: 1, completed: 0 };
      const row = batch.rows.find((r) => r.id === job.payload.id);
      if (row) {
        const config =
          generate || job.payload.extraction ? null : parseLlmConfig(env);
        const provider = config
          ? createOpenAICompatible({
              name: "thesis-learning",
              apiKey: config.apiKey,
              baseURL: config.baseURL,
            })
          : null;
        const relatedCandidates = (
          await pool.query(
            "SELECT id,version,payload FROM lesson_candidates WHERE user_id=$1 AND status IN ('pending_review','approved') AND payload->'scope'->>'domain'='Sports' AND payload->'scope'->>'eventId'=$2 ORDER BY recorded_at DESC LIMIT 10",
            [job.user_id, row.event_id],
          )
        ).rows.flatMap((r) => {
          const p = candidateSchema.safeParse(r.payload);
          return p.success
            ? [{ id: r.id, version: r.version, candidate: p.data }]
            : [];
        });
        const deadline = Date.now() + 60000;
        const initialAdditional = batch.rows
          .filter((e) => e.id !== row.id)
          .map((e) => ({ id: e.id, experience: e.payload }));
        const extract = async (
          additionalExperiences: { id: string; experience: unknown }[],
        ) =>
          extractExperienceCandidates(
            {
              userId: job.user_id,
              experienceId: row.id,
              ...(config ? { extractionModelVersion: config.model } : {}),
              experience: row.payload,
              additionalExperiences,
              relatedCandidates,
              scope: { domain: "Sports", eventId: row.event_id },
              knownAt: new Date(row.known_at),
            },
            async (request) => {
              const remaining = deadline - Date.now();
              if (remaining < 1000) throw Error("EXTRACTION_DEADLINE");
              const inputBytes =
                Buffer.byteLength(request.system, "utf8") +
                Buffer.byteLength(request.prompt, "utf8");
              await reserveLearningExtraction(pool, {
                ownerId: job.user_id,
                jobId: job.id,
                leaseToken: token,
                inputBytes,
                maxInputBytes,
                maxOutputTokens,
                ownerDailyAttempts,
                globalDailyAttempts,
              });
              let actualTokenUsage: {
                inputTokens: number | null;
                outputTokens: number | null;
                totalTokens: number | null;
              } | null = null;
              const saveTrace = async (status: "succeeded" | "failed") =>
                pool.query(
                  "UPDATE learning_jobs SET payload=jsonb_set(payload,'{generationTraces}',COALESCE(payload->'generationTraces','[]'::jsonb)||jsonb_build_array($3::jsonb||jsonb_build_object('recordedAt',clock_timestamp(),'attempt',$4::int))) WHERE id=$1 AND lease_token=$2",
                  [
                    job.id,
                    token,
                    JSON.stringify({
                      source: generate
                        ? "injected_generator"
                        : "provider_response",
                      status,
                      modelVersion: config?.model ?? row.payload.modelVersion,
                      actualTokenUsage,
                    }),
                    job.attempts,
                  ],
                );
              try {
                let output: unknown;
                if (generate) output = await generate(request);
                else {
                  if (!provider || !config)
                    throw new Error("LLM_NOT_CONFIGURED");
                  const response = await generateText({
                    model: provider.chatModel(config.model),
                    system: request.system,
                    prompt: request.prompt,
                    maxOutputTokens,
                    maxRetries: 0,
                    abortSignal: AbortSignal.timeout(remaining),
                  });
                  actualTokenUsage = {
                    inputTokens: response.usage.inputTokens ?? null,
                    outputTokens: response.usage.outputTokens ?? null,
                    totalTokens: response.usage.totalTokens ?? null,
                  };
                  output = JSON.parse(response.text) as unknown;
                }
                await saveTrace("succeeded");
                return output;
              } catch (error) {
                await saveTrace("failed");
                throw error;
              }
            },
          );
        let result = job.payload.extraction
          ? {
              status:
                job.payload.extraction.status === "incomplete"
                  ? ("incomplete" as const)
                  : ("extracted" as const),
              candidates: (job.payload.extraction.candidates as unknown[]).map(
                (v) => candidateSchema.parse(v),
              ),
              error: null,
              omittedAtomIds:
                job.payload.extraction.omittedAtomIds ?? ([] as string[]),
            }
          : await extract(initialAdditional);
        if (
          !job.payload.extraction &&
          result.status === "incomplete" &&
          result.error === "MISSING_CRITICAL_CONTEXT"
        ) {
          await pool.query(
            "UPDATE learning_jobs SET payload=jsonb_set(payload,'{initialIncomplete}',$3::jsonb) WHERE id=$1 AND lease_token=$2",
            [
              job.id,
              token,
              JSON.stringify({
                reason: result.error,
                atomIds: result.omittedAtomIds,
              }),
            ],
          );
          const expanded = await expandLearningContext(pool, {
            ownerId: job.user_id,
            jobId: job.id,
            leaseToken: token,
            sessionId: row.session_id,
            eventId: row.event_id,
            runIds: batch.rows.map((r) => r.run_id),
            knownAt: new Date(row.known_at).toISOString(),
            existingExperienceIds: batch.rows.map((r) => r.id),
          });
          await pool.query(
            "UPDATE learning_jobs SET payload=jsonb_set(payload,'{contextExpansion}',$3::jsonb) WHERE id=$1 AND lease_token=$2",
            [
              job.id,
              token,
              JSON.stringify({
                ...expanded,
                experiences: expanded.experiences.map((e) => ({ id: e.id })),
              }),
            ],
          );
          if (expanded.experiences.length)
            result = await extract([
              ...initialAdditional,
              ...expanded.experiences,
            ]);
        }
        if (result.status === "incomplete") incomplete = true;
        if (result.status === "failed")
          throw new Error(result.error ?? "EXTRACTION_FAILED");
        if (!job.payload.extraction) {
          const staged = await pool.query(
            "UPDATE learning_jobs SET payload=jsonb_set(payload,'{extraction}',$3::jsonb) WHERE id=$1 AND lease_token=$2 AND state='processing' AND lease_until>clock_timestamp()",
            [
              job.id,
              token,
              JSON.stringify({
                candidates: result.candidates,
                omittedAtomIds: result.omittedAtomIds,
                status: result.status,
              }),
            ],
          );
          if (staged.rowCount !== 1) throw new Error("LEARNING_LEASE_LOST");
        }
        // One recap is one observational sample, never five independent lessons.
        const recapBased =
          row.payload.prerequisites?.includes("decision_recap");
        for (const [i, candidate] of (recapBased
          ? result.candidates.slice(0, 1)
          : result.candidates
        ).entries()) {
          const previous = (
            await pool.query(
              "SELECT id,payload FROM lesson_candidates WHERE user_id=$1 AND status IN ('pending_review','approved') ORDER BY recorded_at DESC LIMIT 100",
              [job.user_id],
            )
          ).rows.flatMap((row) => {
            const parsed = candidateSchema.safeParse(row.payload);
            return parsed.success ? [{ ...parsed.data, id: row.id }] : [];
          });
          const consolidation = classifyConsolidation(candidate, previous);
          await pool.query(
            "UPDATE learning_jobs SET payload=jsonb_set(payload,'{consolidationReviews}',COALESCE(payload->'consolidationReviews','[]'::jsonb)||jsonb_build_array($3::jsonb)) WHERE id=$1 AND lease_token=$2 AND state='processing' AND lease_until>clock_timestamp()",
            [
              job.id,
              token,
              JSON.stringify({ candidateIndex: i, ...consolidation }),
            ],
          );
          if (
            consolidation.classification === "no_increment" &&
            !consolidation.requiresReview
          )
            continue;
          // Persist model output for review only after rechecking consent following the remote call.
          const consent = (
            await pool.query(
              "SELECT memory_consent FROM conversations WHERE user_id=$1 AND id=$2",
              [job.user_id, row.session_id],
            )
          ).rows[0]?.memory_consent;
          if (!consent) break;
          await createLessonCandidate(
            pool,
            job.user_id,
            { ...candidate, requestId: stableId(`candidate:${job.id}:${i}`) },
            { jobId: job.id, leaseToken: token },
          );
        }
      }
    }
    const completion = await pool.query(
      `UPDATE learning_jobs SET state='completed',lease_until=NULL,last_error=$3 WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()`,
      [job.id, token, incomplete ? "EXTRACTION_INCOMPLETE" : null],
    );
    return { checked: 1, completed: completion.rowCount === 1 ? 1 : 0 };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (reason === "EXTRACTION_BUDGET_DEFERRED") {
      await pool.query(
        "UPDATE learning_jobs SET state='retry',attempts=GREATEST(0,attempts-1),retry_at=(date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC',lease_until=NULL,last_error='EXTRACTION_BUDGET_DEFERRED' WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()",
        [job.id, token],
      );
      return { checked: 1, completed: 0 };
    }
    if (reason === "EXTRACTION_INPUT_LIMIT") {
      await pool.query(
        "UPDATE learning_jobs SET state='failed',lease_until=NULL,last_error='EXTRACTION_INPUT_LIMIT' WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()",
        [job.id, token],
      );
      return { checked: 1, completed: 0 };
    }
    const diagnostic = [
      "LLM_NOT_CONFIGURED",
      "LEARNING_LEASE_LOST",
      "INVALID_BATCH_MEMBERSHIP",
      "INVALID_EXTRACTION_OUTPUT",
      "INVALID_CONSOLIDATION_REFERENCE",
      "INVALID_CONSOLIDATION_SCOPE",
      "INVALID_CONSOLIDATION_EVIDENCE",
      "EXTRACTION_DEADLINE",
      "SETTLEMENT_NOT_SCORABLE",
      "ORIGINAL_MESSAGE_MISMATCH",
      "ORIGINAL_TOOL_RESULT_MISMATCH",
      "MEMORY_CONSENT_REQUIRED",
      "EVIDENCE_WITHDRAWN",
      "UNVERIFIED_SETTLEMENT_ORIGINAL",
      "FOREIGN_EXPERIENCE_REFERENCE",
      "INVALID_EXPERIENCE_REFERENCE",
      "INVALID_EVIDENCE_REFERENCE",
      "CANDIDATE_SCOPE_MISMATCH",
      "EXTRACTION_VERSION_MISMATCH",
      "UNSUPPORTED_PROBABILITY",
      "EXPIRED_CONDITION",
      "SENSITIVE_CANDIDATE_REJECTED",
      "INVALID_INCOMPLETE_REFERENCE",
      "UNGROUNDED_QUOTE",
      "EVIDENCE_SCOPE_MISMATCH",
      "INELIGIBLE_EVIDENCE_ORIGIN",
    ].includes(reason)
      ? reason
      : "EXTRACTION_OR_PROVIDER_FAILED";
    await pool.query(
      `UPDATE learning_jobs SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'retry' END,retry_at=clock_timestamp()+interval '5 minutes',lease_until=NULL,last_error=$3 WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()`,
      [job.id, token, diagnostic],
    );
    return { checked: 1, completed: 0 };
  }
}
