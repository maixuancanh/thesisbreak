import { config } from "dotenv";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createChatSession } from "../packages/db/src/chat-sessions";
import { claimRun, finishRun } from "../packages/db/src/agent-runs";
import { runResearch } from "../packages/agent/src/runtime";
import {
  createOfficialPlanner,
  createOfficialGenerator,
} from "../packages/agent/src/provider";
import { parseLlmConfig } from "../packages/agent/src/context";
import { runOneLearningJob } from "../packages/integrations/src/learning-worker";
import {
  listLearningCandidates,
  reviewLessonCandidate,
} from "../packages/db/src/experience-learning";
import {
  claimMemoryOutbox,
  finishMemoryOutbox,
} from "../packages/db/src/memory-outbox";
import { processMemoryClaim } from "../packages/integrations/src/memory-sync";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
import { listLessons } from "../packages/db/src/lessons";
import { recallApprovedContext } from "../packages/agent/src/approved-recall";
config({ path: ".local/production-runtime.env", override: true, quiet: true });
if (!process.argv.includes("--authorized-evaluation"))
  throw Error("EXPLICIT_EVALUATION_FLAG_REQUIRED");
const id = JSON.parse(
  await readFile(".local/forecast-evaluation-account.json", "utf8"),
);
if (!id.purpose.includes("Isolated")) throw Error("ISOLATED_IDENTITY_REQUIRED");
const frozen = JSON.parse(
  await readFile(
    ".local/learning-action-pair-2026-10-30T08-29-55-990Z/provider-snapshot.json",
    "utf8",
  ),
);
const m = frozen.market;
const dir = resolve(
  `.local/learning-g1-g3-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
await mkdir(dir);
const save = (f: string, v: unknown) =>
  writeFile(resolve(dir, f), JSON.stringify(v, null, 2) + "\n", { flag: "wx" });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  userId: id.userId,
  purpose:
    "Authorized isolated workflow test, not a forecast; no picks, outcomes or trades created",
  G1: false,
  G2: false,
  G3: false,
  dir,
};
let adapter: MemwalAdapter | undefined;
try {
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  const instruction = `This is an explicitly authorized isolated workflow acceptance test, not a forecast or an assertion about the match. For this event only (${m.eventId}), remember my research procedure: require an official starting lineup before reconsidering any pick. If no current official lineup is available, wait and do not propose a pick. This procedure expires at ${expiresAt}. Please propose this procedure for review based only on this original instruction; do not invent a result, probability or prior successful experience.`;
  const market = {
    platform: m.platform,
    nativeId: m.id,
    question: [m.eventTitle, m.question]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 2000),
    outcomes: m.outcomes.map((o: { name: string }) => o.name),
    rules: m.rules,
  };
  const plan = createOfficialPlanner(process.env),
    generate = createOfficialGenerator(process.env);
  const raw: unknown[] = [];
  const dependencies = (lessons: () => Promise<unknown[]>) => ({
    plan: async (input: Parameters<typeof plan>[0]) => {
      const output = await plan(input);
      raw.push({ stage: "planner", input, output });
      return output;
    },
    generate: async (input: Parameters<typeof generate>[0]) => {
      const output = await generate(input);
      raw.push({ stage: "generator", input, output });
      return output;
    },
    readPick: async () => null,
    readLessons: lessons,
    readComparison: async () => [],
    readIndependent: async () => structuredClone(frozen.independent),
    marketSource: {
      id: "market-source",
      url: m.sourceUrl,
      text: JSON.stringify(m).slice(0, 9500),
      retrievedAt: m.fetchedAt,
      kind: "market" as const,
    },
  });
  const sessionA = await createChatSession(pool, id.userId, true);
  const runA = await claimRun(pool, id.userId, {
    sessionId: sessionA.id,
    platform: m.platform,
    nativeId: m.id,
    provider: "public",
    message: instruction,
    requestId: randomUUID(),
  });
  report.sessionA = sessionA.id;
  report.runA = runA.id;
  await save("instruction.json", {
    instruction,
    expiresAt,
    market,
    frozenAt: frozen.frozenAt,
  });
  const resultA = await runResearch(
    {
      userId: id.userId,
      market,
      message: instruction,
      history: [],
      domain: "Sports",
      eventId: m.eventId,
      now: new Date(),
    },
    dependencies(async () => []),
  );
  await finishRun(
    pool,
    id.userId,
    runA.id,
    {
      ...resultA,
      modelVersion: parseLlmConfig(process.env).model,
      promptVersion: "authorized-isolated-learning-acceptance-v1",
    },
    "completed",
  );
  await save("session-a-runtime.json", { raw: [...raw], result: resultA });
  for (let i = 0; i < 5; i++) {
    const x = await runOneLearningJob(pool, process.env, undefined, id.userId);
    await save(`learning-job-${i}.json`, x);
    const candidates = await listLearningCandidates(pool, id.userId);
    if (
      candidates.some(
        (c) =>
          c.payload.condition?.type === "require_official_lineup" &&
          c.payload.scope.eventId === m.eventId &&
          c.status === "pending_review",
      )
    )
      break;
    if (x.checked === 0) break;
  }
  const experience = (
    await pool.query(
      "SELECT * FROM learning_experiences WHERE user_id=$1 AND run_id=$2",
      [id.userId, runA.id],
    )
  ).rows;
  const jobs = (
    await pool.query(
      "SELECT * FROM learning_jobs WHERE user_id=$1 AND kind IN ('capture','extract') ORDER BY recorded_at DESC LIMIT 10",
      [id.userId],
    )
  ).rows;
  await save("capture-extraction.json", { experience, jobs });
  const candidates = await listLearningCandidates(pool, id.userId);
  await save("candidate-review.json", candidates);
  const candidate = candidates.find(
    (c) =>
      c.status === "pending_review" &&
      c.payload.condition?.type === "require_official_lineup" &&
      c.payload.scope.eventId === m.eventId &&
      experience.some((e) => c.payload.experienceIds.includes(e.id)),
  );
  if (!candidate)
    throw Error("NO_MODEL_EXTRACTED_TYPED_LINEUP_CANDIDATE_PENDING_REVIEW");
  report.G1 = true;
  report.candidateId = candidate.id;
  const approval = await reviewLessonCandidate(pool, id.userId, candidate.id, {
    requestId: randomUUID(),
    baseVersion: candidate.version,
    action: "approve",
    confirmed: true,
    memoryConsent: true,
  });
  report.approval = approval;
  await save("explicit-test-approval.json", {
    authorization:
      "User explicitly authorized isolated evaluation account complete test loop, including test approval",
    candidate,
    approval,
  });
  adapter = new MemwalAdapter(
    officialMemwalClient(parseMemwalConfig(process.env)),
    id.userId,
  );
  for (let i = 0; i < 8; i++) {
    const claim = await claimMemoryOutbox(pool, 150000, id.userId);
    if (!claim) break;
    const result = await processMemoryClaim(claim, adapter, 120000);
    const saved = await finishMemoryOutbox(pool, claim, result);
    await save(`mainnet-sync-${i}.json`, { claim, result, saved });
    if (claim.record.type === "lesson" && result.status === "verified") {
      report.G2 = true;
      break;
    }
    if (result.status !== "verified") break;
  }
  if (!report.G2)
    throw Error("APPROVED_LESSON_MAINNET_WRITE_READBACK_NOT_VERIFIED");
  const loadCurrent = async () =>
    (await listLessons(pool, id.userId))
      .filter((x) => x.sync.state === "synced" || x.sync.state === "verified")
      .map((x) => x.lesson);
  // Outbox states can be 'completed' depending on writer version; authority still requires exact remote equality below.
  const owned = (await listLessons(pool, id.userId)).map((x) => x.lesson);
  await save("current-lessons.json", owned);
  const sessionB = await createChatSession(pool, id.userId, true);
  report.sessionB = sessionB.id;
  raw.length = 0;
  const query =
    "For this isolated workflow test, review whether a pick can be reconsidered now under my remembered procedure. Do not make any transaction or save a pick.";
  const recalled = await recallApprovedContext({
    userId: id.userId,
    domain: "Sports",
    eventId: m.eventId,
    now: new Date(),
    query,
    loadCurrent: async () => owned,
    recall: async (q) => {
      const output = await adapter!.recall(q);
      raw.push({ stage: "fresh_sdk_recall", output });
      return output;
    },
  });
  await save("fresh-session-b-recall.json", recalled);
  if (
    !recalled.some(
      (l) => l.learningCondition?.type === "require_official_lineup",
    )
  )
    throw Error("EXACT_TYPED_LESSON_NOT_RECALLED_IN_FRESH_SESSION");
  const runB = await claimRun(pool, id.userId, {
    sessionId: sessionB.id,
    platform: m.platform,
    nativeId: m.id,
    provider: "public",
    message: query,
    requestId: randomUUID(),
  });
  report.runB = runB.id;
  const resultB = await runResearch(
    {
      userId: id.userId,
      market,
      message: query,
      history: [],
      domain: "Sports",
      eventId: m.eventId,
      now: new Date(),
    },
    dependencies(async () => recalled),
  );
  await finishRun(
    pool,
    id.userId,
    runB.id,
    {
      ...resultB,
      modelVersion: parseLlmConfig(process.env).model,
      promptVersion: "authorized-isolated-learning-acceptance-v1",
    },
    "completed",
  );
  await save("fresh-session-b-runtime.json", { raw, result: resultB });
  report.G3 =
    resultB.policyRequiredTools.includes("read_independent_sources") &&
    resultB.appliedConditions.some(
      (c) => c.condition === "require_official_lineup",
    ) &&
    resultB.trace.some(
      (t) => t.tool === "read_independent_sources" && t.status === "completed",
    ) &&
    !resultB.reply.proposedPick &&
    !resultB.reply.proposedChange;
  report.status = report.G3
    ? "G1_G2_G3_VERIFIED_DIRECT_RUNTIME_PRODUCTION_DB_MAINNET"
    : "G3_NOT_ESTABLISHED";
  report.sessionBPolicy = {
    requiredTools: resultB.policyRequiredTools,
    selectedTools: resultB.plannedTools,
    gate: resultB.learningGate,
    applied: resultB.appliedConditions,
  };
  void loadCurrent;
} catch (e) {
  report.status = "incomplete";
  report.error = e instanceof Error ? e.message : "UNKNOWN";
} finally {
  adapter?.destroy();
  report.completedAt = new Date().toISOString();
  await save("report.json", report);
  await pool.end();
  console.log(JSON.stringify(report));
}
