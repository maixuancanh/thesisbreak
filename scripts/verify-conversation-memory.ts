import "dotenv/config";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import {
  createChatSession,
  chatHistory,
  syncChatMemory,
  recallChatMemories,
} from "../packages/db/src/chat-sessions";
import { claimRun, finishRun } from "../packages/db/src/agent-runs";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
import { TatumCatalog } from "../packages/integrations/src/tatum/catalog";
import { TatumResearch } from "../packages/integrations/src/tatum/research";
import { reserveProviderCredits } from "../packages/db/src/provider-budget";
import {
  createOfficialGenerator,
  createOfficialPlanner,
} from "../packages/agent/src/provider";
import {
  runResearch,
  type ResearchSource,
} from "../packages/agent/src/runtime";
if (!process.argv.includes("--enable-remote-writes"))
  throw Error(
    "Pass --enable-remote-writes to authorize an isolated Walrus Mainnet verification write.",
  );
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const userId = randomUUID();
const proof: Record<string, unknown> = {
  checkedAt: new Date().toISOString(),
  scope:
    "Isolated verification account, configured PostgreSQL, real Walrus Mainnet, deployed LLM, real Tatum. This is a controlled action test, not evidence of better forecasting accuracy.",
};
const adapter = new MemwalAdapter(
  officialMemwalClient(parseMemwalConfig(process.env)),
  userId,
);
let phase = "catalog";
try {
  const reserve = (cost: number) =>
    reserveProviderCredits(
      pool,
      "tatum",
      cost,
      Number(process.env.TATUM_DAILY_CREDIT_LIMIT ?? 1000),
    );
  const catalog = new TatumCatalog(
    process.env.TATUM_API_KEY ?? "",
    fetch,
    reserve,
  );
  const research = new TatumResearch(
    process.env.TATUM_API_KEY ?? "",
    fetch,
    reserve,
  );
  const page = await catalog.list({ platform: "kalshi", limit: 1 });
  const row = page.data[0];
  if (!row) throw Error("CATALOG_EMPTY");
  const market = {
    platform: "kalshi" as const,
    nativeId: row.id,
    question: row.question ?? row.id,
    outcomes: ["Yes", "No"],
    rules: null,
  };
  proof.market = market;
  await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$2)", [
    userId,
    `session-proof:${userId}`,
  ]);
  const a = await createChatSession(pool, userId, true),
    b = await createChatSession(pool, userId, false);
  proof.sessions = { a: a.id, b: b.id };
  phase = "checkpoint";
  const run = await claimRun(pool, userId, {
    sessionId: a.id,
    platform: "kalshi",
    nativeId: row.id,
    provider: "tatum",
    message:
      "My view depends on whether the last seven days of market-price movement support it. A single current quote is not enough to review that reasoning.",
    requestId: randomUUID(),
  });
  await finishRun(
    pool,
    userId,
    run.id,
    {
      marketQuestion: market.question,
      reply: {
        message:
          "Your stated reason concerns the seven-day price trend. That is historical reasoning, not evidence that your pick is right.",
      },
      sources: [],
    },
    "completed",
  );
  phase = "walrus_write";
  const write = await syncChatMemory(pool, adapter, userId);
  proof.write = write;
  console.log(JSON.stringify({ phase, ...write }));
  if (write.state !== "verified") throw Error("WALRUS_NOT_VERIFIED");
  phase = "walrus_recall";
  const memories = await recallChatMemories(
    pool,
    adapter,
    userId,
    b.id,
    `${market.question} seven days market-price movement`,
  );
  proof.recall = {
    sessions: memories.map((m) => ({
      sessionId: m.sessionId,
      version: m.version,
      blobId: m.blobId,
    })),
    newSessionTranscriptCount: (await chatHistory(pool, userId, b.id)).length,
  };
  if (!memories.length) throw Error("NO_CROSS_SESSION_RECALL");
  phase = "runtime";
  for (const enabled of [false, true]) {
    const actions: string[] = [];
    const out = await runResearch(
      {
        userId,
        market,
        message: "Should I reconsider my view on this market?",
        history: [],
        domain: "test",
        now: new Date(),
      },
      {
        plan: createOfficialPlanner(process.env),
        generate: createOfficialGenerator(process.env),
        readPick: async () => null,
        readLessons: async () => [],
        readSessionMemories: async () => (enabled ? memories : []),
        readComparison: async () => [],
        marketSource: {
          id: "market-source",
          text: JSON.stringify(row),
          retrievedAt: new Date().toISOString(),
          url: "https://kalshi.com",
        },
        readTatumHistory: async () => {
          actions.push("read_tatum_history");
          const end = new Date(),
            start = new Date(end.getTime() - 7 * 86400000);
          const h = await research.history({
            platform: "kalshi",
            id: row.id,
            interval: "1h",
            source: "candlesticks",
            start: start.toISOString(),
            end: end.toISOString(),
          });
          return [
            {
              id: "tatum-history",
              text: JSON.stringify(h),
              retrievedAt: end.toISOString(),
              url: "https://api.tatum.io",
              kind: "market",
            },
          ] as ResearchSource[];
        },
        readTatumQuote: async () => {
          actions.push("read_tatum_quote");
          const q = await research.quote({ platform: "kalshi", id: row.id });
          return [
            {
              id: "tatum-quote",
              text: JSON.stringify(q),
              retrievedAt: new Date().toISOString(),
              url: "https://api.tatum.io",
              kind: "market",
            },
          ] as ResearchSource[];
        },
      },
    );
    proof[enabled ? "withMemory" : "withoutMemory"] = {
      plannedTools: out.plannedTools,
      actualActions: actions,
      trace: out.trace,
      reply: out.reply,
    };
    console.log(
      JSON.stringify({
        phase: enabled ? "withMemory" : "withoutMemory",
        tools: out.plannedTools,
        actions,
      }),
    );
  }
  const withM = proof.withMemory as {
      actualActions: string[];
      trace: { tool: string; status: string; count: number }[];
    },
    without = proof.withoutMemory as { actualActions: string[] };
  proof.changedAction =
    withM.actualActions.includes("read_tatum_history") &&
    !without.actualActions.includes("read_tatum_history");
  proof.historyReadSucceeded = withM.trace.some(
    (t) =>
      t.tool === "read_tatum_history" &&
      t.status === "completed" &&
      t.count > 0,
  );
  proof.status =
    proof.changedAction && proof.historyReadSucceeded
      ? "passed"
      : "inconclusive";
  if (proof.status !== "passed") process.exitCode = 1;
} catch (e) {
  proof.status = "failed";
  proof.failedPhase = phase;
  proof.error = e instanceof Error ? e.message : "FAILED";
  console.log(JSON.stringify({ phase, status: "failed", error: proof.error }));
  process.exitCode = 1;
} finally {
  writeFileSync(
    ".local/session-memory-live-proof.json",
    JSON.stringify(proof, null, 2),
  );
  adapter.destroy();
  await pool.end();
}
