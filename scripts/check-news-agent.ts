import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { PublicCatalog } from "../packages/integrations/src/public-catalog";
import {
  collectIndependent,
  independentAgentSources,
} from "../packages/integrations/src/news/collect";
import { saveIndependentChecks } from "../packages/db/src/independent-evidence";
import { listLessons } from "../packages/db/src/lessons";
import { authorizedRecalledLessons } from "../packages/agent/src/recalled-lessons";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
import { runResearch } from "../packages/agent/src/runtime";
import {
  createOfficialGenerator,
  createOfficialPlanner,
} from "../packages/agent/src/provider";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let adapter: MemwalAdapter | undefined;
try {
  const state = JSON.parse(readFileSync(".local/memory-journey.json", "utf8"));
  const current = (await listLessons(pool, state.userId)).map((r) => r.lesson);
  const lesson = current.find(
    (l) => l.status === "active" && l.approval === "approved",
  );
  if (!lesson) throw Error("NO_APPROVED_ACCEPTANCE_LESSON");
  adapter = new MemwalAdapter(
    officialMemwalClient(parseMemwalConfig(process.env)),
    state.userId,
  );
  const recalled = authorizedRecalledLessons(
    current,
    (await adapter.recall(lesson.rule)).records,
  );
  const m = (
    await new PublicCatalog().get("kalshi", "KXNBAGAME-26OCT25LALUTA-LAL")
  ).data[0];
  if (!m) throw Error("MARKET_UNAVAILABLE");
  const checks = await collectIndependent({
    platform: m.platform,
    nativeId: m.id,
    eventId: m.eventId,
  });
  await saveIndependentChecks(
    pool,
    { platform: m.platform, nativeId: m.id },
    checks,
  );
  const news = checks.find((c) => c.source === "nba-official")?.items[0];
  if (!news) throw Error("REPORT_UNAVAILABLE");
  const query = `Use my approved preference. What does the supplied official NBA injury report say about ${news.player}? Distinguish injury participation status from a confirmed starting lineup. Cite the official report; do not draft or change a pick.`;
  const result = await runResearch(
    {
      userId: state.userId,
      market: {
        platform: m.platform,
        nativeId: m.id,
        question: m.question,
        outcomes: m.outcomes.map((o) => o.name),
        rules: m.rules,
      },
      message: query,
      domain: "Sports",
      history: [],
      now: new Date(),
    },
    {
      plan: createOfficialPlanner(process.env),
      generate: createOfficialGenerator(process.env),
      readPick: async () => null,
      readComparison: async () => [],
      readLessons: async () => recalled,
      marketSource: {
        id: "market-source",
        url: m.sourceUrl ?? "",
        text: JSON.stringify({
          question: m.question,
          rules: m.rules,
          prices: m.outcomes,
        }),
        retrievedAt: m.fetchedAt,
      },
      readIndependent: async () => independentAgentSources(checks, query),
    },
  );
  const proof = {
    checkedAt: new Date().toISOString(),
    market: m.id,
    officialCitations: result.sources.filter((s) =>
      s.id.startsWith("news:nba-official:"),
    ).length,
    approvedLessonsUsed: result.usedLessons.length,
    reply: result.reply.message,
    remoteWrites: 0,
    scope:
      "Existing labelled acceptance account; actual public report and actual model. No authenticated browser journey or adoption claim.",
  };
  writeFileSync(".local/news-agent-proof.json", JSON.stringify(proof, null, 2));
  console.log(
    JSON.stringify({
      check: "news.agent_memory",
      officialCitations: proof.officialCitations,
      approvedLessonsUsed: proof.approvedLessonsUsed,
      remoteWrites: 0,
    }),
  );
  if (!proof.officialCitations || !proof.approvedLessonsUsed)
    process.exitCode = 1;
} catch {
  console.log(
    JSON.stringify({
      check: "news.agent_memory",
      status: "failed",
      detail:
        "Provider, evidence or strict validation unavailable; no private data logged",
    }),
  );
  process.exitCode = 1;
} finally {
  adapter?.destroy();
  await pool.end();
}
