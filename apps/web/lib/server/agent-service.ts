import { recallNbaForecastMemories } from "../../../../packages/db/src/forecast-ledger";
import { recallActionHistory } from "../../../../packages/db/src/action-history";
import "server-only";
import { saveAnswerClaims } from "../../../../packages/db/src/claim-challenges";
import { persistReviewCaseDebateFromRun } from "../../../../packages/db/src/review-cases";
import { parseTemporalRequest } from "../../../../packages/agent/src/temporal-retrieval";
import { readHistoricalResearchEvidence } from "../../../../packages/db/src/historical-research";
import {
  publicAgentResult,
  publicAgentRuns,
} from "../../../../packages/agent/src/public-result";
import { readEventDossier } from "../../../../packages/db/src/event-dossier";
import { createTatumReaders } from "./tatum-service";
import { Pool } from "pg";
import { z } from "zod";
import {
  requireUser,
  authConfigured,
  assertMutationOrigin,
  AuthError,
} from "./auth";
import { readLiveCatalog, liveQuerySchema } from "./live-catalog";
import { readPickIntelligence } from "./pick-intelligence";
import { livePageSchema } from "../live-market";
import { readReviewSettlement } from "../../../../packages/db/src/review-settlement";
import { listSourceScores } from "../../../../packages/db/src/source-credibility";
import { sourceCohort } from "../../../../packages/domain/src/source-credibility";
import {
  chatHistory,
  recallChatMemories,
} from "../../../../packages/db/src/chat-sessions";
import { recallSourceContext } from "../../../../packages/agent/src/source-recall";
import { loadIndependent } from "./independent-service";
import { independentAgentSources } from "../../../../packages/integrations/src/news/collect";
import {
  agentMessageSchema,
  claimRun,
  finishRun,
  conversationHistory,
  RunConflict,
} from "../../../../packages/db/src/agent-runs";
import { parseLlmConfig } from "../../../../packages/agent/src/context";
import {
  createOfficialPlanner,
  createOfficialGenerator,
} from "../../../../packages/agent/src/provider";
import { recallApprovedContext } from "../../../../packages/agent/src/approved-recall";
import {
  runResearch,
  recentHistory,
} from "../../../../packages/agent/src/runtime";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../../../../packages/integrations/src/memwal";
import { loadCurrentApprovedLessons } from "../../../../packages/db/src/approved-lessons";
import { createConfiguredMemoryIndex } from "../../../../packages/integrations/src/graphiti-bridge";
import { APPROVED_LESSON_INDEX_NAMESPACE } from "../../../../packages/domain/src/approved-lesson-index";
import { registerRunAbort, unregisterRunAbort } from "./run-control-service";
import { boundedJsonBody } from "./bounded-json-body";
import { logRequestFailure, type RequestStage } from "./request-diagnostics";
let pool: Pool | undefined;
function db() {
  if (!process.env.DATABASE_URL)
    throw new AuthError(503, "DATABASE_NOT_CONFIGURED");
  return (pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    allowExitOnIdle: true,
  }));
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
export function agentAvailability() {
  let model = false;
  try {
    parseLlmConfig(process.env);
    model = true;
  } catch {}
  return {
    configured: authConfigured() && model,
    modelConfigured: model,
    accountConfigured: authConfigured(),
    memoryConfigured: !!(
      process.env.MEMWAL_ACCOUNT_ID && process.env.MEMWAL_DELEGATE_KEY
    ),
  };
}
function errorResponse(error: unknown, stage: RequestStage) {
  if (error instanceof AuthError)
    return json({ error: error.message }, error.status);
  if (stage === "input" && error instanceof z.ZodError)
    return json({ error: "INVALID_INPUT" }, 400);
  if (error instanceof RunConflict) return json({ error: error.message }, 409);
  return json({ error: "AGENT_UNAVAILABLE" }, 503);
}
export async function agentHistory(request: Request) {
  let stage: RequestStage = "authorization";
  try {
    const user = await requireUser();
    stage = "input";
    const url = new URL(request.url);
    const query = liveQuerySchema.parse(Object.fromEntries(url.searchParams));
    if (!query.id) throw new AuthError(400, "MARKET_REQUIRED");
    stage = "history";
    const rows = await conversationHistory(
      db(),
      user.id,
      query.platform,
      query.id,
    );
    return json({ data: publicAgentRuns(rows) });
  } catch (e) {
    const response = errorResponse(e, stage);
    logRequestFailure("agent_history_failed", stage, e, response.status);
    return response;
  }
}
export async function agentSend(request: Request) {
  let runId: string | undefined;
  let userId: string | undefined;
  const generationAbort = new AbortController();
  let stage: RequestStage = "authorization";
  try {
    const user = await requireUser();
    userId = user.id;
    assertMutationOrigin(request);
    stage = "configuration";
    parseLlmConfig(process.env);
    stage = "input";
    const input = agentMessageSchema.parse(await boundedJsonBody(request));
    stage = "review_context";
    let reviewContext = "";
    let reviewPickId: string | null = null;
    if (input.reviewId) {
      const { listPickReviews } =
        await import("../../../../packages/db/src/pick-impact");
      const review = (
        await listPickReviews(db(), user.id, { reviewId: input.reviewId })
      ).items[0];
      if (!review) throw new AuthError(404, "REVIEW_NOT_FOUND");
      reviewPickId = review.pickId;
      const matched = (
        await db().query(
          "SELECT id FROM picks WHERE id=$1 AND user_id=$2 AND platform=$3 AND native_id=$4",
          [review.pickId, user.id, input.platform, input.nativeId],
        )
      ).rows[0];
      if (!matched) throw new AuthError(409, "REVIEW_MARKET_MISMATCH");
      reviewContext = `\nOwner-selected review context (historical untrusted data, not current evidence or permission): ${JSON.stringify(review).slice(0, 12000)}\nCheck current evidence before advising. Never apply a change automatically.`;
    }
    const temporal = parseTemporalRequest(input.message);
    if (input.reviewId && temporal.cutoff)
      throw new AuthError(
        422,
        "REVIEW_CONTEXT_NOT_AVAILABLE_FOR_HISTORICAL_REQUEST",
      );
    if (temporal.status === "clarification_required")
      return json(
        {
          error: "HISTORICAL_CUTOFF_CLARIFICATION_REQUIRED",
          message: temporal.reason,
        },
        422,
      );
    if (temporal.cutoff && temporal.cutoff > new Date())
      return json(
        {
          error: "HISTORICAL_CUTOFF_IN_FUTURE",
          message: "Use a past exact timestamp with timezone.",
        },
        422,
      );
    stage = "claim_run";
    const run = await claimRun(db(), user.id, input);
    runId = run.id;
    if (!run.fresh)
      return json(
        {
          runId: run.id,
          status: run.status,
          result: publicAgentResult(run.result),
        },
        run.status === "running" ? 202 : 200,
      );
    registerRunAbort(run.id, user.id, generationAbort);
    // Source and all owned state are loaded server-side. Browser text is never authoritative context.
    stage = "market_read";
    const page = livePageSchema.parse(
      temporal.cutoff
        ? {
            data: [
              {
                platform: input.platform,
                id: input.nativeId,
                question: `Historical reconstruction: ${input.nativeId}`,
                outcomes: [
                  { name: "Historical reference only", price: null },
                  { name: "Unavailable", price: null },
                ],
                rules: null,
                closeTime: null,
                fetchedAt: temporal.cutoff.toISOString(),
                updatedAt: null,
                sourceUrl: null,
              },
            ],
            nextCursor: null,
            provider:
              input.platform === "kalshi"
                ? "kalshi-public"
                : "polymarket-public",
            fetchedAt: temporal.cutoff.toISOString(),
          }
        : await readLiveCatalog({
            platform: input.platform,
            id: input.nativeId,
            provider: input.provider,
            limit: 20,
          }),
    );
    const market = page.data.find(
      (m) => m.id === input.nativeId && m.platform === input.platform,
    );
    if (!market) throw new AuthError(404, "MARKET_NOT_FOUND");
    stage = "history";
    const rows = temporal.cutoff
      ? []
      : input.sessionId
        ? await chatHistory(db(), user.id, input.sessionId)
        : await conversationHistory(
            db(),
            user.id,
            input.platform,
            input.nativeId,
          );
    const history = recentHistory(
      rows
        .filter((r) => r.status === "completed")
        .flatMap((r) => [
          {
            role: "user" as const,
            text: `${r.platform && r.native_id ? `[Market: ${r.platform}/${r.native_id}] ` : ""}${r.message as string}`,
          },
          {
            role: "assistant" as const,
            text: String(r.result?.reply?.message ?? ""),
          },
        ])
        .slice(-16),
    );
    let memoryState = "not_requested";
    let verifiedLessonProofs: { id: string; version: number; hash: string }[] =
      [];
    const readPick = async () => {
      const result = await db().query(
        "SELECT p.id,p.current_version,v.outcome,v.reason FROM picks p JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id AND v.version=p.current_version WHERE p.user_id=$1 AND p.platform=$2 AND p.native_id=$3 AND ($4::text IS NULL OR p.id::text=$4) ORDER BY p.created_at DESC LIMIT 1",
        [user.id, input.platform, input.nativeId, reviewPickId],
      );
      const row = result.rows[0];
      return row
        ? {
            userId: user.id,
            pickId: row.id as string,
            version: row.current_version as number,
            outcome: row.outcome as string,
            reason: row.reason as string,
            market: { platform: input.platform, nativeId: input.nativeId },
          }
        : null;
    };
    // Bind a reviewed immutable procedure once per run; rollout is explicit.
    const configuredProcedure = process.env.PROCEDURE_VERSION;
    const activeProcedure = configuredProcedure
      ? await (
          await import("../../../../packages/db/src/procedure-versions")
        ).getActiveProcedure(db())
      : null;
    if (configuredProcedure && activeProcedure?.id !== configuredProcedure)
      throw Error("PROCEDURE_VERSION_NOT_ACTIVE");
    const { researchCallBudget } =
      await import("../../../../packages/domain/src/research-call-budget");
    const debateRequested =
      process.env.DEBATE_MODE === "opt_in" &&
      /\b(challenge my view|argue against|debate this)\b/i.test(input.message);
    const callBudget = researchCallBudget(debateRequested ? 5 : 2);
    stage = "research";
    const decisionChecks = await readPickIntelligence(db(), user.id, market, reviewPickId);
    const result = await runResearch(
      {
        userId: user.id,
        market: {
          platform: input.platform,
          nativeId: input.nativeId,
          question: [market.eventTitle, market.question, market.conditionLabel]
            .filter(Boolean)
            .join(" · ")
            .slice(0, 2000),
          outcomes: market.outcomes.map((o) => o.name),
          rules: market.rules?.slice(0, 20000) ?? null,
        },
        message: input.message + reviewContext,
        ...(input.compareMemory ? { compareMemory: true } : {}),
        history,
        domain: market.category ?? "unclassified",
        eventId: market.eventId ?? `${input.platform}:${input.nativeId}`,
        ...(/^KXNBAGAME-/i.test(input.nativeId)
          ? {
              requestedScope: {
                league: "NBA",
                market: "winner",
                horizon: /\bT24h\b/i.test(input.message)
                  ? "T24h"
                  : /\bT60m\b/i.test(input.message)
                    ? "T60m"
                    : "pregame",
              },
              currentRegime: `NBA-season-${new Date().getUTCMonth() >= 8 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1}`,
            }
          : {}),
        ...(market.competition ? { competition: market.competition } : {}),
        now: new Date(),
      },
      {
        decisionChecks,
        plan: async (input) => {
          stage = "planning";
          generationAbort.signal.throwIfAborted();
          if (!callBudget.reserve(1))
            throw Error("RESEARCH_CALL_BUDGET_EXHAUSTED");
          const plan = await createOfficialPlanner(
            process.env,
            undefined,
            generationAbort.signal,
          )(input);
          stage = "research";
          return plan;
        },
        generate: async (input) => {
          stage = "generation";
          generationAbort.signal.throwIfAborted();
          if (!callBudget.reserve(1))
            throw Error("RESEARCH_CALL_BUDGET_EXHAUSTED");
          const guidance = activeProcedure
            ? (
                await import("../../../../packages/domain/src/procedure-version")
              ).applyReviewedProcedureToSystem(
                input.system,
                activeProcedure.content,
              )
            : "";
          return createOfficialGenerator(process.env)({
            ...input,
            system: guidance || input.system,
            signal: generationAbort.signal,
          });
        },
        ...(debateRequested
          ? {
              evidenceDebate: {
                trigger: "explicit_challenge" as const,
                reserveCalls: (count: 3) => callBudget.reserve(count),
                invoke: (
                  await import("../../../../packages/agent/src/provider")
                ).createOfficialDebateInvoker(process.env),
                maxOutputTokens: 1500,
              },
            }
          : {}),
        ...createTatumReaders(db(), {
          platform: input.platform,
          nativeId: input.nativeId,
          sourceUrl: market.sourceUrl,
          signal: generationAbort.signal,
        }),
        readPick,
        ...(process.env.RESEARCH_ARTIFACT_MEMORY_ENABLED === "true" &&
        market.eventId
          ? {
              readResearchArtifacts: async () => {
                const rows = (
                  await db().query(
                    `SELECT id,reviewer_id FROM research_artifact_memory_publications WHERE owner_id=$1 AND state='verified' AND (record->'payload'->'snapshot'->>'event_id'=$2 OR record->'payload'->'snapshot'->'payload'->>'eventId'=$2) ORDER BY created_at DESC LIMIT 4`,
                    [user.id, market.eventId],
                  )
                ).rows;
                const { recallResearchArtifactForPlanning } =
                  await import("../../../../packages/integrations/src/research-artifact-memory");
                const evidence: unknown[] = [];
                for (const row of rows) {
                  const recalled = await recallResearchArtifactForPlanning(
                    db(),
                    {
                      id: row.id,
                      ownerId: user.id,
                      reviewerId: row.reviewer_id,
                      createAdapter: () =>
                        new MemwalAdapter(
                          officialMemwalClient(parseMemwalConfig(process.env)),
                          user.id,
                        ),
                    },
                  );
                  if (recalled.status === "verified")
                    evidence.push(...recalled.evidence);
                }
                return evidence;
              },
            }
          : {}),
        readHistoricalEvidence: (cutoff) =>
          readHistoricalResearchEvidence(db(), {
            userId: user.id,
            platform: input.platform,
            nativeId: input.nativeId,
            cutoff,
          }),
        readSessionMemories: async () => {
          if (
            !input.sessionId ||
            !process.env.MEMWAL_ACCOUNT_ID ||
            !process.env.MEMWAL_DELEGATE_KEY
          )
            return [];
          const a = new MemwalAdapter(
            officialMemwalClient(parseMemwalConfig(process.env)),
            user.id,
          );
          try {
            return await recallChatMemories(
              db(),
              a,
              user.id,
              input.sessionId,
              `${market.eventTitle ?? ""} ${market.question} ${input.message}`,
            );
          } finally {
            a.destroy();
          }
        },
        readForecastMemories: async () => {
          if (
            !process.env.MEMWAL_DELEGATE_KEY ||
            !process.env.MEMWAL_ACCOUNT_ID
          )
            return [];
          const adapter = new MemwalAdapter(
            officialMemwalClient(parseMemwalConfig(process.env)),
            user.id,
          );
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              recallNbaForecastMemories(db(), user.id, (q) =>
                adapter.recall(q),
              ),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(Error("FORECAST_RECALL_TIMEOUT")),
                  12000,
                );
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
            adapter.destroy();
          }
        },
        readActionMemories: async () => {
          if (
            !process.env.MEMWAL_ACCOUNT_ID ||
            !process.env.MEMWAL_DELEGATE_KEY
          )
            return [];
          const a = new MemwalAdapter(
            officialMemwalClient(parseMemwalConfig(process.env)),
            user.id,
          );
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              recallActionHistory(db(), user.id, (q) => a.recall(q)),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(Error("ACTION_RECALL_TIMEOUT")),
                  12000,
                );
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
            a.destroy();
          }
        },
        readSourceMemories: async () => {
          if (
            !process.env.MEMWAL_DELEGATE_KEY ||
            !process.env.MEMWAL_ACCOUNT_ID
          )
            return [];
          const cohort = sourceCohort(market);
          const loadCurrent = () => listSourceScores(db(), user.id, cohort);
          const current = await loadCurrent();
          if (!current.some((s) => s.active && s.memoryConsent)) return [];
          const adapter = new MemwalAdapter(
            officialMemwalClient(parseMemwalConfig(process.env)),
            user.id,
          );
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              recallSourceContext({
                userId: user.id,
                cohort,
                loadCurrent,
                recall: (q) => adapter.recall(q),
              }),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("SOURCE_RECALL_TIMEOUT")),
                  12000,
                );
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
            adapter.destroy();
          }
        },
        readSettlement: (pick) =>
          readReviewSettlement(db(), pick, {
            provider: page.provider,
            resolution: market.resolution ?? null,
          }),
        readIndependent: async () =>
          independentAgentSources(
            await loadIndependent({
              platform: input.platform,
              nativeId: input.nativeId,
              eventId: market.eventId ?? null,
            }),
            `${input.message} ${(await readPick())?.reason ?? ""}`,
          ),
        marketSource: {
          id: "market-source",
          url: market.sourceUrl ?? "",
          retrievedAt: market.fetchedAt,
          text: JSON.stringify({
            decisionChecks,
            event: market.eventTitle,
            condition: market.question,
            label: market.conditionLabel,
            prices: market.outcomes,
            priceBasis: market.priceBasis,
            scheduledAt: market.scheduledAt,
            closeTime: market.closeTime,
            fetchedAt: market.fetchedAt,
            rules: market.rules,
          }).slice(0, 9500),
        },
        readComparison: async () => {
          const old = await db().query(
            "SELECT s.id,s.outcomes,s.rules_hash,s.raw->>'rules' AS rules,s.fetched_at,s.rules_reference FROM picks p JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id AND v.version=p.current_version JOIN market_snapshots s ON s.id=v.snapshot_id WHERE p.user_id=$1 AND p.platform=$2 AND p.native_id=$3 AND ($4::text IS NULL OR p.id::text=$4) ORDER BY p.created_at DESC LIMIT 1",
            [user.id, input.platform, input.nativeId, reviewPickId],
          );
          const snapshot = old.rows[0];
          return snapshot
            ? [
                {
                  id: "saved-snapshot",
                  url: snapshot.rules_reference as string,
                  retrievedAt: new Date(snapshot.fetched_at).toISOString(),
                  kind: "snapshot" as const,
                  text: JSON.stringify({
                    note: "Previously saved snapshot, not fresh news",
                    outcomes: snapshot.outcomes,
                    rulesHash: snapshot.rules_hash,
                    rules: typeof snapshot.rules === "string" ? snapshot.rules.slice(0, 6000) : null,
                    capturedAt: snapshot.fetched_at,
                  }).slice(0, 9500),
                },
              ]
            : [];
        },
        ...(process.env.THESISBREAK_ACCOUNTABILITY_ENABLED === "true"
          ? { checkProcedures: { maxCalls: 1 } }
          : {}),
        readLessons: async () => {
          verifiedLessonProofs = [];
          const loadCurrentLessons = async () => {
            return loadCurrentApprovedLessons(db(), user.id);
          };
          if (
            !process.env.MEMWAL_DELEGATE_KEY ||
            !process.env.MEMWAL_ACCOUNT_ID
          ) {
            memoryState = "account_only";
            return [];
          }
          const adapter = new MemwalAdapter(
            officialMemwalClient(parseMemwalConfig(process.env)),
            user.id,
          );
          try {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const recalled = await Promise.race([
              recallApprovedContext({
                query: input.message,
                eventId:
                  market.eventId ?? `${input.platform}:${input.nativeId}`,
                userId: user.id,
                domain: market.category ?? "unclassified",
                ...(market.competition
                  ? { competition: market.competition }
                  : {}),
                now: new Date(),
                ...(process.env.GRAPH_RETRIEVAL_MODE === "verified" &&
                market.eventId &&
                market.scheduledAt
                  ? {
                      indexCandidates: async () =>
                        (
                          await createConfiguredMemoryIndex(db())({
                            ownerId: user.id,
                            namespace: APPROVED_LESSON_INDEX_NAMESPACE,
                            event: {
                              provider: input.platform,
                              nativeId: market.eventId!,
                              date: market.scheduledAt!.slice(0, 10),
                            },
                            cutoffAt: new Date().toISOString(),
                            query: input.message,
                            entities: [
                              {
                                kind: "event",
                                provider: input.platform,
                                nativeId: market.eventId!,
                              },
                            ],
                            scope: {
                              domain: market.category ?? "unclassified",
                              ...(market.competition
                                ? { competition: market.competition }
                                : {}),
                            },
                          })
                        ).map((edge) => edge.pointer),
                    }
                  : {}),
                loadCurrent: loadCurrentLessons,
                recall: async (q) => {
                  const result = await adapter.recall(q);
                  for (const r of result.records)
                    if (r.type === "lesson")
                      verifiedLessonProofs.push({
                        id: r.logicalId,
                        version: r.version,
                        hash: r.hash,
                      });
                  return result;
                },
              }),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("MEMORY_TIMEOUT")),
                  12000,
                );
              }),
            ]).finally(() => {
              if (timer) clearTimeout(timer);
            });
            memoryState = "walrus_recalled";
            return recalled;
          } finally {
            adapter.destroy();
          }
        },
        readDossier: () =>
          readEventDossier(
            db(),
            user.id,
            market.eventId ?? `${input.platform}:${input.nativeId}`,
          ),
        readLessonProofs: () => [
          ...new Map(
            verifiedLessonProofs.map((p) => [`${p.id}:${p.version}`, p]),
          ).values(),
        ],
      },
    );
    generationAbort.signal.throwIfAborted();
    const output = {
      ...result,
      modelVersion: parseLlmConfig(process.env).model,
      promptVersion: "research-v1",
      ...(input.learningTrigger
        ? { learningTrigger: input.learningTrigger }
        : {}),
      memoryState,
      marketRef: { platform: input.platform, nativeId: input.nativeId },
      marketQuestion: [market.eventTitle, market.question]
        .filter(Boolean)
        .join(" · "),
      sessionId: run.conversationId,
    };
    stage = "persist_result";
    await finishRun(db(), user.id, run.id, output, "completed");
    if (
      process.env.THESISBREAK_ACCOUNTABILITY_ENABLED === "true" &&
      input.reviewId
    ) {
      try {
        await persistReviewCaseDebateFromRun(
          db(),
          user.id,
          input.reviewId,
          run.id,
        );
      } catch {
        console.error("review_case_debate_unavailable", { runId: run.id });
      }
    }
    if (
      process.env.THESISBREAK_ACCOUNTABILITY_ENABLED === "true" &&
      output.reply.answerClaims?.length
    ) {
      try {
        await saveAnswerClaims(
          db(),
          user.id,
          run.id,
          output.reply.answerClaims,
        );
      } catch {
        console.error("answer_claim_anchor_unavailable", { runId: run.id });
      }
    }
    return json({
      runId: run.id,
      status: "completed",
      result: publicAgentResult(output),
    });
  } catch (e) {
    const response = errorResponse(e, stage);
    logRequestFailure("agent_request_failed", stage, e, response.status, runId);
    if (runId && userId)
      try {
        await finishRun(
          db(),
          userId,
          runId,
          { error: "AGENT_UNAVAILABLE" },
          "failed",
        );
      } catch (error) {
        logRequestFailure(
          "agent_request_failed",
          "persist_failure",
          error,
          503,
          runId,
        );
      }
    return response;
  } finally {
    if (runId) unregisterRunAbort(runId, generationAbort);
  }
}
