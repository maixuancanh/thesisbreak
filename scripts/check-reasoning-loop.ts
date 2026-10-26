import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import { PublicCatalog } from "../packages/integrations/src/public-catalog";
import {
  collectIndependent,
  independentAgentSources,
} from "../packages/integrations/src/news/collect";
import { runResearch } from "../packages/agent/src/runtime";
import {
  createOfficialPlanner,
  createOfficialGenerator,
} from "../packages/agent/src/provider";
import { createPick } from "../packages/db/src/picks";
import { readReviewSettlement } from "../packages/db/src/review-settlement";
import { listLessons } from "../packages/db/src/lessons";
import { authorizedRecalledLessons } from "../packages/agent/src/recalled-lessons";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
if (!process.argv.includes("--local-fixture"))
  throw Error(
    "Explicit --local-fixture required: creates one labelled local journal record, no Walrus writes",
  );
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let adapter: MemwalAdapter | undefined;
try {
  const owner = JSON.parse(readFileSync(".local/memory-journey.json", "utf8"))
    .userId as string;
  const m = (
    await new PublicCatalog().get("kalshi", "KXNBAGAME-26OCT25LALUTA-LAL")
  ).data[0];
  if (!m?.resolution) throw Error("FINAL_SETTLEMENT_UNAVAILABLE");
  const checks = await collectIndependent({
    platform: m.platform,
    nativeId: m.id,
    eventId: m.eventId,
  });
  const person = checks
    .find((c) => c.source === "nba-official")
    ?.items.find((i) => i.status === "Out" && i.player);
  if (!person?.player) throw Error("OFFICIAL_REPORT_UNAVAILABLE");
  const pieces = person.player.split(",").map((s) => s.trim());
  const name =
    pieces.length === 2 ? `${pieces[1]} ${pieces[0]}` : person.player;
  const stateFile = ".local/reasoning-loop-fixture.json";
  const state = existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, "utf8"))
    : {
        requestId: randomUUID(),
        reason: `Labelled acceptance scenario only, recorded after the result; not a genuine forecast. Assumption under review: I expect ${name} to start.`,
      };
  writeFileSync(stateFile, JSON.stringify(state));
  const saved = (await createPick(
    pool,
    owner,
    {
      platform: m.platform,
      nativeId: m.id,
      outcome: "Yes",
      reason: state.reason,
      requestId: state.requestId,
    },
    async () => ({
      platform: m.platform,
      nativeId: m.id,
      eventId: m.eventId,
      question: m.question,
      outcomes: m.outcomes,
      rulesReference: m.sourceUrl!,
      rulesHash: createHash("sha256")
        .update(m.rules ?? "")
        .digest("hex"),
      closeTime: m.closeTime,
      fetchedAt: m.fetchedAt,
      priceAsOf: null,
      nativeUnit: "probability",
      raw: { catalogProvider: "public", acceptanceFixture: true },
    }),
  )) as { pickId: string; version: number };
  const pick = {
    userId: owner,
    pickId: saved.pickId,
    version: 1,
    market: { platform: m.platform, nativeId: m.id },
    outcome: "Yes",
    reason: state.reason,
  };
  const lessons = (await listLessons(pool, owner)).map((r) => r.lesson);
  adapter = new MemwalAdapter(
    officialMemwalClient(parseMemwalConfig(process.env)),
    owner,
  );
  const active = lessons.find(
    (l) => l.status === "active" && l.approval === "approved",
  );
  const recalled = active
    ? authorizedRecalledLessons(
        lessons,
        (await adapter.recall(active.rule)).records,
      )
    : [];
  const query =
    "Review the actual final result and the explicitly labelled assumption in my saved reason. Cite direct report evidence for support/contradiction and cite final-settlement for the retrospective. Distinguish result from reasoning quality and note this entry was saved after the result. Apply my approved preference and suggest at most one cautious procedural lesson for review. Do not apply changes or save memory.";
  const result = await runResearch(
    {
      userId: owner,
      market: {
        platform: m.platform,
        nativeId: m.id,
        question: m.question,
        outcomes: m.outcomes.map((o) => o.name),
        rules: m.rules,
      },
      message: query,
      history: [],
      domain: "Sports",
      now: new Date(),
    },
    {
      plan: createOfficialPlanner(process.env),
      generate: createOfficialGenerator(process.env),
      readPick: async () => pick,
      readLessons: async () => recalled,
      readComparison: async () => [],
      readIndependent: async () =>
        independentAgentSources(checks, state.reason),
      readSettlement: (p) =>
        readReviewSettlement(pool, p, {
          provider: "kalshi-public",
          resolution: m.resolution ?? null,
        }),
      marketSource: {
        id: "market-source",
        text: JSON.stringify({
          question: m.question,
          rules: m.rules,
          prices: m.outcomes,
        }),
        url: m.sourceUrl!,
        retrievedAt: m.fetchedAt,
      },
    },
  );
  const proof = {
    checkedAt: new Date().toISOString(),
    scope:
      "One labelled local journal fixture recorded after settlement, actual public source/model/approved remote memory; no memory writes or adoption claim",
    reasonReview: result.reply.reasonReview,
    retrospective: result.reply.retrospective,
    outcomeReview: result.outcomeReview,
    usedLessons: result.usedLessons.length,
    sourceCount: result.sources.length,
    remoteWrites: 0,
  };
  writeFileSync(
    ".local/reasoning-loop-proof.json",
    JSON.stringify(proof, null, 2),
  );
  console.log(
    JSON.stringify({
      check: "reasoning.loop",
      review: !!proof.reasonReview,
      retrospective: !!proof.retrospective,
      lessonDraft: !!proof.retrospective?.reasoningLesson,
      comparison: proof.outcomeReview?.comparison,
      usedLessons: proof.usedLessons,
      remoteWrites: 0,
    }),
  );
  if (
    !proof.reasonReview ||
    !proof.retrospective ||
    proof.outcomeReview?.comparison !== "not_scored"
  )
    process.exitCode = 1;
} catch (e) {
  console.log(
    JSON.stringify({
      check: "reasoning.loop",
      status: "failed",
      code:
        e instanceof Error && /^[A-Z_]+$/.test(e.message)
          ? e.message
          : "PROVIDER_OR_VALIDATION_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  adapter?.destroy();
  await pool.end();
}
