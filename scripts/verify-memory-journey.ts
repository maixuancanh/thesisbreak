/** Explicit live acceptance drill. One labelled test lesson; never quota padding. */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createApprovedLesson, listLessons } from "../packages/db/src/lessons";
import {
  claimMemoryOutbox,
  finishMemoryOutbox,
} from "../packages/db/src/memory-outbox";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
import { processMemoryClaim } from "../packages/integrations/src/memory-sync";
import { authorizedRecalledLessons } from "../packages/agent/src/recalled-lessons";
import { runResearch } from "../packages/agent/src/runtime";
import {
  createOfficialPlanner,
  createOfficialGenerator,
} from "../packages/agent/src/provider";
if (!process.argv.includes("--write-mainnet"))
  throw new Error(
    "Explicit --write-mainnet required; this writes one labelled acceptance-test lesson",
  );
mkdirSync(".local", { recursive: true });
const file = ".local/memory-journey.json";
const state = existsSync(file)
  ? JSON.parse(readFileSync(file, "utf8"))
  : {
      userId: `thesisbreak-acceptance-${randomUUID()}`,
      requestId: randomUUID(),
    };
writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const config = parseMemwalConfig(process.env);
try {
  await pool.query(
    "INSERT INTO users(id,provider_subject) VALUES($1,$1) ON CONFLICT DO NOTHING",
    [state.userId],
  );
  const saved = await createApprovedLesson(pool, state.userId, {
    requestId: state.requestId,
    rule: "For sports events, wait for an official lineup before treating lineup rumors as confirmed. Market prices alone do not confirm a lineup.",
    scope: { domain: "Sports" },
    confirmed: true,
    memoryConsent: true,
  });
  const claim = await claimMemoryOutbox(pool);
  if (claim) {
    const adapter = new MemwalAdapter(
      officialMemwalClient(config),
      claim.userId,
    );
    try {
      const result = await processMemoryClaim(claim, adapter);
      await finishMemoryOutbox(pool, claim, result);
      console.log(
        JSON.stringify({
          check: "memory.write_readback",
          status: result.status,
        }),
      );
    } finally {
      adapter.destroy();
    }
  }
  // Fresh SDK client and database reads model a separate session, not in-memory history.
  const current = await listLessons(pool, state.userId);
  const lesson = current.find((r) => r.lesson.id === saved.lessonId)?.lesson;
  if (!lesson) throw new Error("MISSING_SAVED_LESSON");
  const fresh = new MemwalAdapter(officialMemwalClient(config), state.userId);
  let recalled;
  try {
    recalled = await fresh.recall(lesson.rule);
  } finally {
    fresh.destroy();
  }
  const accepted = authorizedRecalledLessons([lesson], recalled.records);
  if (!accepted.length) throw new Error("MEMORY_NOT_RECALLED");
  const result = await runResearch(
    {
      userId: state.userId,
      market: {
        platform: "kalshi",
        nativeId: "ACCEPTANCE-CASE-B",
        question:
          "Acceptance fixture: should an unconfirmed lineup report change my view?",
        outcomes: ["Yes", "No"],
        rules:
          "This is a labelled acceptance scenario, not a real listed market.",
      },
      message:
        "A new event has several reposts about a lineup change but no official lineup yet. Apply my relevant approved preference and explain what to wait for. Do not draft or change a pick.",
      history: [],
      domain: "Sports",
      now: new Date(),
    },
    {
      plan: createOfficialPlanner(process.env),
      generate: createOfficialGenerator(process.env),
      readPick: async () => null,
      readLessons: async () => accepted,
      readComparison: async () => [],
      marketSource: {
        id: "market-source",
        text: "Acceptance fixture: reposted lineup claims only. No official team sheet supplied. This is not live news.",
        url: "",
        retrievedAt: new Date().toISOString(),
      },
    },
  );
  const proof = {
    ...state,
    lessonId: lesson.id,
    version: lesson.version,
    recordCount: accepted.length,
    usedLessons: result.usedLessons,
    reply: result.reply.message,
    verifiedAt: new Date().toISOString(),
    label:
      "Live SDK acceptance fixture; not a real user adoption claim or ten-memory requirement proof",
  };
  writeFileSync(file, JSON.stringify(proof, null, 2), { mode: 0o600 });
  if (!result.usedLessons.some((l) => l.id === lesson.id))
    throw new Error("LESSON_NOT_REFERENCED");
  console.log(
    JSON.stringify({
      check: "fresh_session.case_b",
      status: "pass",
      usedLessons: result.usedLessons.length,
      proof: file,
    }),
  );
} catch (e) {
  console.log(
    JSON.stringify({
      status: "failed",
      code:
        e instanceof Error && /^[A-Z_]+$/.test(e.message)
          ? e.message
          : "LIVE_JOURNEY_UNAVAILABLE",
      detail: "No provider bodies or secrets logged",
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
