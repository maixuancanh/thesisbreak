import { recallNbaForecastMemories } from "../../../../packages/db/src/forecast-ledger";
import "server-only";
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
import { lessonVersionSchema } from "../../../../packages/domain/src/lesson";
import { registerRunAbort, unregisterRunAbort } from "./run-control-service";
import { lessonRowToPayload } from "../../../../packages/db/src/memory-outbox";
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
async function boundedBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, "INVALID_JSON");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16384) {
        await reader.cancel();
        throw new AuthError(413, "BODY_TOO_LARGE");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AuthError(400, "INVALID_JSON");
  }
}
function errorResponse(error: unknown) {
  if (error instanceof AuthError)
    return json({ error: error.message }, error.status);
  if (error instanceof z.ZodError) return json({ error: "INVALID_INPUT" }, 400);
  if (error instanceof RunConflict) return json({ error: error.message }, 409);
  return json({ error: "AGENT_UNAVAILABLE" }, 503);
}
export async function agentHistory(request: Request) {
  try {
    const user = await requireUser();
    const url = new URL(request.url);
    const query = liveQuerySchema.parse(Object.fromEntries(url.searchParams));
    if (!query.id) throw new AuthError(400, "MARKET_REQUIRED");
    const rows = await conversationHistory(
      db(),
      user.id,
      query.platform,
      query.id,
    );
    return json({ data: rows });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function agentSend(request: Request) {
  let runId: string | undefined;
  let userId: string | undefined;
  const generationAbort = new AbortController();
  try {
    const user = await requireUser();
    userId = user.id;
    assertMutationOrigin(request);
    parseLlmConfig(process.env);
    const input = agentMessageSchema.parse(await boundedBody(request));
    const run = await claimRun(db(), user.id, input);
    runId = run.id;
    if (!run.fresh)
      return json(
        { runId: run.id, status: run.status, result: run.result },
        run.status === "running" ? 202 : 200,
      );
    registerRunAbort(run.id, user.id, generationAbort);
    // Source and all owned state are loaded server-side. Browser text is never authoritative context.
    const page = livePageSchema.parse(
      await readLiveCatalog({
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
    const rows = input.sessionId
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
    const readPick = async () => {
      const result = await db().query(
        "SELECT p.id,p.current_version,v.outcome,v.reason FROM picks p JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id AND v.version=p.current_version WHERE p.user_id=$1 AND p.platform=$2 AND p.native_id=$3 ORDER BY p.created_at DESC LIMIT 1",
        [user.id, input.platform, input.nativeId],
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
        message: input.message,
        ...(input.compareMemory ? { compareMemory: true } : {}),
        history,
        domain: market.category ?? "unclassified",
        ...(market.competition ? { competition: market.competition } : {}),
        now: new Date(),
      },
      {
        plan: async (input) => {
          generationAbort.signal.throwIfAborted();
          return createOfficialPlanner(process.env)(input);
        },
        generate: async (input) => {
          generationAbort.signal.throwIfAborted();
          return createOfficialGenerator(process.env)({
            ...input,
            signal: generationAbort.signal,
          });
        },
        ...createTatumReaders(db(), {
          platform: input.platform,
          nativeId: input.nativeId,
          sourceUrl: market.sourceUrl,
          signal: generationAbort.signal,
        }),
        readPick,
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
          try {
            return await recallNbaForecastMemories(db(), user.id, (q) =>
              adapter.recall(q),
            );
          } finally {
            adapter.destroy();
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
            "SELECT s.id,s.outcomes,s.rules_hash,s.fetched_at,s.rules_reference FROM picks p JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id AND v.version=p.current_version JOIN market_snapshots s ON s.id=v.snapshot_id WHERE p.user_id=$1 AND p.platform=$2 AND p.native_id=$3 ORDER BY p.created_at DESC LIMIT 1",
            [user.id, input.platform, input.nativeId],
          );
          const snapshot = old.rows[0];
          return snapshot
            ? [
                {
                  id: "saved-snapshot",
                  url: snapshot.rules_reference as string,
                  retrievedAt: new Date(snapshot.fetched_at).toISOString(),
                  text: JSON.stringify({
                    note: "Previously saved snapshot, not fresh news",
                    outcomes: snapshot.outcomes,
                    rulesHash: snapshot.rules_hash,
                    capturedAt: snapshot.fetched_at,
                  }).slice(0, 9500),
                },
              ]
            : [];
        },
        readLessons: async () => {
          const loadCurrentLessons = async () => {
            const found = await db().query(
              "SELECT l.id,v.* FROM lessons l JOIN lesson_versions v ON v.lesson_id=l.id AND v.user_id=l.user_id AND v.version=l.current_version WHERE l.user_id=$1 AND v.approval='approved' AND v.status='active' LIMIT 50",
              [user.id],
            );
            return found.rows
              .map((r) => lessonRowToPayload(r))
              .filter((l) => lessonVersionSchema.safeParse(l).success);
          };
          if (
            !process.env.MEMWAL_DELEGATE_KEY ||
            !process.env.MEMWAL_ACCOUNT_ID
          ) {
            memoryState = "account_only";
            return loadCurrentLessons();
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
                userId: user.id,
                domain: market.category ?? "unclassified",
                ...(market.competition
                  ? { competition: market.competition }
                  : {}),
                now: new Date(),
                loadCurrent: loadCurrentLessons,
                recall: (q) => adapter.recall(q),
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
      },
    );
    generationAbort.signal.throwIfAborted();
    const output = {
      ...result,
      memoryState,
      marketRef: { platform: input.platform, nativeId: input.nativeId },
      marketQuestion: [market.eventTitle, market.question]
        .filter(Boolean)
        .join(" · "),
      sessionId: run.conversationId,
    };
    await finishRun(db(), user.id, run.id, output, "completed");
    return json({ runId: run.id, status: "completed", result: output });
  } catch (e) {
    if (runId && userId)
      try {
        await finishRun(
          db(),
          userId,
          runId,
          { error: "AGENT_UNAVAILABLE" },
          "failed",
        );
      } catch {}
    return errorResponse(e);
  } finally {
    if (runId) unregisterRunAbort(runId, generationAbort);
  }
}
