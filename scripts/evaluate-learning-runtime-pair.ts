import { rememberedConditions } from "../packages/agent/src/remembered-conditions";
import {
  isLessonApplicable,
  lessonVersionSchema,
} from "../packages/domain/src/lesson";
import { config } from "dotenv";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import { PublicCatalog } from "../packages/integrations/src/public-catalog";
import {
  collectIndependent,
  independentAgentSources,
} from "../packages/integrations/src/news/collect";
import {
  runResearch,
  type ResearchSource,
} from "../packages/agent/src/runtime";
import {
  createOfficialPlanner,
  createOfficialGenerator,
} from "../packages/agent/src/provider";
import { parseLlmConfig } from "../packages/agent/src/context";
import { recallActionHistory } from "../packages/db/src/action-history";
import { listLessons } from "../packages/db/src/lessons";
import { recallApprovedContext } from "../packages/agent/src/approved-recall";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
import {
  evaluateLearningPairs,
  type LearningActionAttempt,
} from "../packages/domain/src/learning-evaluation";
if (!process.argv.includes("--live-model"))
  throw Error(
    "Pass --live-model: four bounded LLM calls, fresh read-only Walrus/provider/DB reads; no account mutations",
  );
config({ path: ".local/production-runtime.env", override: true, quiet: true });
const identity = z
  .object({
    userId: z.string(),
    nativeId: z.string(),
    market: z
      .object({ platform: z.enum(["kalshi", "polymarket"]) })
      .passthrough(),
  })
  .passthrough()
  .parse(
    JSON.parse(await readFile(".local/action-live-acceptance.json", "utf8")),
  );
const useLearningAccount = process.argv.includes(
  "--learning-evaluation-account",
);
if (useLearningAccount) {
  const account = JSON.parse(
    await readFile(".local/forecast-evaluation-account.json", "utf8"),
  );
  if (!account.purpose.includes("Isolated"))
    throw Error("ISOLATED_ACCOUNT_REQUIRED");
  identity.userId = account.userId;
}
const dir = resolve(
  `.local/learning-action-pair-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
await mkdir(dir, { recursive: false });
const save = (name: string, value: unknown) =>
  writeFile(resolve(dir, name), JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
  });
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let adapter: MemwalAdapter | undefined;
const attempts: LearningActionAttempt[] = [];
const metadata: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  output: dir,
  mode: "read_only_matched_actual_runtime",
  productionRecordMutations: 0,
  remoteWrites: 0,
  costMeasurement: "unavailable",
  latencyMeasurement: "wall_clock",
  humanRubricReview: "not_performed",
  accuracyImprovementEstablished: false,
};
try {
  const model = parseLlmConfig(process.env);
  metadata.modelVersion = model.model;
  const catalog = await new PublicCatalog().get(
    identity.market.platform,
    identity.nativeId,
  );
  const m = catalog.data[0];
  if (!m) throw Error("FRESH_NATIVE_MARKET_UNAVAILABLE");
  const frozenNow = new Date();
  const question =
    "Review the current saved pick against the latest official event evidence and my previously confirmed action. Explain what still needs checking. Draft a change only if current evidence meets my saved conditions; never apply it.";
  const market = {
    platform: m.platform,
    nativeId: m.id,
    question: [m.eventTitle, m.question, m.conditionLabel]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 2000),
    outcomes: m.outcomes.map((o) => o.name),
    rules: m.rules?.slice(0, 20000) ?? null,
  };
  const pickRow = (
    await pool.query(
      "SELECT p.id,p.current_version,v.outcome,v.reason FROM picks p JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id AND v.version=p.current_version WHERE p.user_id=$1 AND p.platform=$2 AND p.native_id=$3 ORDER BY p.created_at DESC LIMIT 1",
      [identity.userId, m.platform, m.id],
    )
  ).rows[0];
  const pick = pickRow
    ? {
        userId: identity.userId,
        pickId: pickRow.id,
        market: { platform: m.platform, nativeId: m.id },
        version: pickRow.current_version,
        outcome: pickRow.outcome,
        reason: pickRow.reason,
      }
    : null;
  const checks = await collectIndependent({
    platform: m.platform,
    nativeId: m.id,
    eventId: m.eventId,
  });
  const independent = independentAgentSources(
    checks,
    `${question} ${pick?.reason ?? ""}`,
  );
  const marketSource: ResearchSource = {
    id: "market-source",
    url: m.sourceUrl ?? "",
    text: JSON.stringify(m).slice(0, 9500),
    retrievedAt: m.fetchedAt,
    kind: "market",
  };
  const frozen = {
    frozenAt: frozenNow.toISOString(),
    market: m,
    pick,
    independent,
    comparison: [],
    capabilities: {
      readIndependent: true,
      readTatumQuote: false,
      readTatumHistory: false,
      readComparison: true,
    },
  };
  await save("provider-snapshot.json", frozen);
  metadata.providerSnapshotHash = hash(frozen);
  metadata.questionHash = hash(question);
  const receiptRows = (
    await pool.query(
      "SELECT r.pick_id,r.revision,m.blob_id,m.hash FROM confirmed_action_results r JOIN action_memory_receipts m ON m.pick_id=r.pick_id AND m.revision=r.revision JOIN action_memory_preferences p ON p.user_id=r.user_id AND p.memory_consent=true WHERE r.user_id=$1 AND r.revision=(SELECT max(revision) FROM confirmed_action_results x WHERE x.pick_id=r.pick_id) ORDER BY r.recorded_at DESC LIMIT 2",
      [identity.userId],
    )
  ).rows;
  const expectedIds = receiptRows.map(
    (r) => `action:${r.pick_id}@${r.revision}`,
  );
  const expectedLessons = (await listLessons(pool, identity.userId))
    .filter((r) => r.sync.state !== "not_requested")
    .map((r) => r.lesson)
    .filter(
      (l) =>
        isLessonApplicable(l, {
          userId: identity.userId,
          domain: m.category ?? "unclassified",
          ...(m.competition ? { competition: m.competition } : {}),
          now: frozenNow,
        }) &&
        (!l.learningScope?.eventId ||
          l.learningScope.eventId === (m.eventId ?? `${m.platform}:${m.id}`)),
    );
  expectedIds.push(...expectedLessons.map((l) => l.id));
  const expectedPolicy = rememberedConditions({
    userId: identity.userId,
    domain: m.category ?? "unclassified",
    ...(m.competition ? { competition: m.competition } : {}),
    eventId: m.eventId ?? `${m.platform}:${m.id}`,
    now: frozenNow,
    lessons: expectedLessons,
  });
  const promptVersion = "learning-action-runtime-pair-v1";
  const plan = createOfficialPlanner(process.env),
    generate = createOfficialGenerator(process.env);
  for (const arm of ["without_memory", "with_memory"] as const) {
    const raw: {
      stage: string;
      input?: unknown;
      output?: unknown;
      error?: string;
    }[] = [];
    const start = Date.now();
    let recalledActions: unknown[] = [];
    let recalledLessons: unknown[] = [];
    let outcome: Awaited<ReturnType<typeof runResearch>> | undefined;
    let failure: string | null = null;
    try {
      if (arm === "with_memory") {
        adapter = new MemwalAdapter(
          officialMemwalClient(parseMemwalConfig(process.env)),
          identity.userId,
        );
        const recall = async (q: string) => {
          const result = await Promise.race([
            adapter!.recall(q),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(Error("PAIR_RECALL_TIMEOUT")), 20000),
            ),
          ]);
          raw.push({ stage: "fresh_sdk_recall", output: result });
          return result;
        };
        recalledActions = await recallActionHistory(
          pool,
          identity.userId,
          recall,
        );
        const owned = (await listLessons(pool, identity.userId))
          .filter((r) => r.sync.state !== "not_requested")
          .map((r) => r.lesson);
        recalledLessons = await recallApprovedContext({
          userId: identity.userId,
          domain: m.category ?? "unclassified",
          ...(m.competition ? { competition: m.competition } : {}),
          eventId: m.eventId ?? `${m.platform}:${m.id}`,
          now: frozenNow,
          query: question,
          loadCurrent: async () => owned,
          recall,
        });
        if (receiptRows.length && !recalledActions.length)
          throw Error("EXPECTED_CURRENT_ACTION_MEMORY_NOT_RECALLED");
      }
      outcome = await runResearch(
        {
          userId: identity.userId,
          market,
          message: question,
          history: [],
          domain: m.category ?? "unclassified",
          ...(m.competition ? { competition: m.competition } : {}),
          eventId: m.eventId ?? `${m.platform}:${m.id}`,
          now: frozenNow,
        },
        {
          plan: async (input) => {
            raw.push({ stage: "planner_request", input });
            try {
              const output = await plan(input);
              raw.push({ stage: "planner_output", output });
              return output;
            } catch (e) {
              raw.push({
                stage: "planner_error",
                error: e instanceof Error ? e.message : "unknown",
              });
              throw e;
            }
          },
          generate: async (input) => {
            raw.push({ stage: "generator_request", input });
            try {
              const output = await generate(input);
              raw.push({ stage: "generator_output", output });
              return output;
            } catch (e) {
              raw.push({
                stage: "generator_error",
                error: e instanceof Error ? e.message : "unknown",
              });
              throw e;
            }
          },
          readPick: async () => structuredClone(pick),
          readLessons: async () => structuredClone(recalledLessons),
          readActionMemories: async () => structuredClone(recalledActions),
          readComparison: async () => [],
          readIndependent: async () => structuredClone(independent),
          marketSource: structuredClone(marketSource),
        },
      );
    } catch (e) {
      failure = e instanceof Error ? e.message : "PAIR_ARM_FAILED";
    } finally {
      adapter?.destroy();
      adapter = undefined;
    }
    const retrievedIds = recalledActions.flatMap((value) => {
      const parsed = z.object({ pickId: z.string() }).safeParse(value);
      if (!parsed.success) return [];
      const row = receiptRows.find((r) => r.pick_id === parsed.data.pickId);
      return row ? [`action:${row.pick_id}@${row.revision}`] : [];
    });
    retrievedIds.push(
      ...recalledLessons.flatMap((l) => {
        const p = lessonVersionSchema.safeParse(l);
        return p.success ? [p.data.id] : [];
      }),
    );
    const attempt: LearningActionAttempt = {
      pairId: "action-live-current",
      fixtureId: `actual-readonly:${m.platform}:${m.id}`,
      arm,
      modelVersion: model.model,
      promptVersion,
      questionHash: hash(question),
      providerSnapshotHash: hash(frozen),
      expectedMemoryIds: expectedIds,
      retrievedMemoryIds: retrievedIds,
      usedMemoryIds: outcome?.reply.lessonRefs ?? [],
      expectedRequiredTools: expectedPolicy.requiredTools,
      policyRequiredTools: outcome?.policyRequiredTools ?? [],
      modelSelectedTools: outcome?.plannedTools ?? [],
      executedTools:
        outcome?.trace
          .filter((t) => t.status === "completed")
          .map((t) => t.tool) ?? [],
      invalidProposal: outcome?.researchAudit.proposalWithheld ?? false,
      proposalBlocked: outcome?.researchAudit.proposalWithheld ?? false,
      plannerTrace: raw
        .filter((x) => x.stage.startsWith("planner_"))
        .map((x) => JSON.stringify(x)).length
        ? raw
            .filter((x) => x.stage.startsWith("planner_"))
            .map((x) => JSON.stringify(x))
        : ["planner_not_reached"],
      toolTrace: outcome?.trace.map((x) => JSON.stringify(x)) ?? [
        "tool_trace_unavailable_before_runtime_completion",
      ],
      latencyMs: Date.now() - start,
      costUsd: null,
      failure,
    };
    attempts.push(attempt);
    await save(`${arm}.json`, {
      attempt,
      raw,
      outcome: outcome ?? null,
      actualRecalledActions: recalledActions,
      actualRecalledLessons: recalledLessons,
    });
    console.log(
      JSON.stringify({
        arm,
        failure,
        latencyMs: attempt.latencyMs,
        policyRequiredTools: attempt.policyRequiredTools,
        modelSelectedTools: attempt.modelSelectedTools,
        executedTools: attempt.executedTools,
        recalledActions: recalledActions.length,
        recalledLessons: recalledLessons.length,
      }),
    );
  }
  const report = evaluateLearningPairs(attempts);
  await save("attempts.json", attempts);
  await save("report.json", {
    ...report,
    totalCostUsd: null,
    costMeasurement: "unavailable",
    usedActionMemoryMeasurement: "not_observable_from_reply_schema",
    typedLessonPolicyEvaluation: expectedPolicy.applied.length
      ? "actual_approved_exact_recalled_condition"
      : "unavailable_no_approved_lesson_for_identity",
    confirmedGroundingImprovement: false,
    limitations: [
      "No new lesson or approval was fabricated.",
      expectedPolicy.applied.length
        ? "Uses approved current lesson; deterministic enforcement differs from model-chosen behavior."
        : "Current identity has no approved typed lesson; action-history context only.",
      "A paired trace is not accuracy improvement or human rubric review.",
      "Cost measurement is unavailable; costUsd remains null rather than an invented zero.",
      "Action memory semantic use is not inferred from assistant prose.",
    ],
  });
  metadata.status = report.failedPairs
    ? "completed_with_failed_pairs"
    : "completed";
  metadata.completedAt = new Date().toISOString();
  metadata.completePairs = report.completePairs;
  metadata.failedPairs = report.failedPairs;
} catch (e) {
  metadata.status = "failed";
  metadata.error = e instanceof Error ? e.message : "EVALUATION_FAILED";
  metadata.completedAt = new Date().toISOString();
} finally {
  adapter?.destroy();
  await pool.end();
  await save("metadata.json", metadata);
  console.log(
    JSON.stringify({
      status: metadata.status,
      error: metadata.error ?? null,
      output: dir,
      completePairs: metadata.completePairs ?? 0,
      failedPairs: metadata.failedPairs ?? 0,
    }),
  );
}
