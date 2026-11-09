import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { config } from "dotenv";
import { z } from "zod";
import { memoryBenchmarkCaseSchema } from "../packages/domain/src/memory-benchmark";
import { lessonVersionSchema } from "../packages/domain/src/lesson";
import { runRuntimeAblations } from "../packages/agent/src/runtime-ablation";
import {
  createOfficialPlanner,
  createOfficialGenerator,
} from "../packages/agent/src/provider";
import { parseLlmConfig } from "../packages/agent/src/context";
import type { ResearchSource } from "../packages/agent/src/runtime";
const args = process.argv.slice(2),
  value = (name: string) =>
    args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
if (value("mode") !== "synthetic")
  throw Error("EXPLICIT_SYNTHETIC_MODE_REQUIRED");
const split = value("split") ?? "development",
  limit = Number(value("limit") ?? 1);
if (
  !["development", "holdout"].includes(split) ||
  !Number.isInteger(limit) ||
  limit < 1 ||
  limit > 6
)
  throw Error("INVALID_SPLIT_OR_LIMIT");
const raw = await readFile(
    "tests/fixtures/pick-review/memory-pair-cases.jsonl",
    "utf8",
  ),
  manifest = JSON.parse(
    await readFile(
      "tests/fixtures/pick-review/memory-pair-manifest.json",
      "utf8",
    ),
  );
const digest = (v: unknown) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : JSON.stringify(v))
    .digest("hex");
if (digest(raw) !== manifest.sha256) throw Error("CORPUS_HASH_MISMATCH");
const rowSchema = z
  .object({
    split: z.enum(["development", "holdout"]),
    fixture: memoryBenchmarkCaseSchema,
    lesson: lessonVersionSchema,
    current: z
      .object({
        id: z.string(),
        kind: z.enum(["news", "official_event"]),
        text: z.string(),
        confirmsLineup: z.boolean(),
      })
      .strict(),
  })
  .strict();
const rows = raw
  .trim()
  .split("\n")
  .map((line) => rowSchema.parse(JSON.parse(line)))
  .filter((r) => r.split === split)
  .slice(0, limit);
const output = resolve(
    value("output") ?? `.local/pick-review-evaluation/model-pair-${Date.now()}`,
  ),
  within = relative(resolve(".local"), output);
if (!within || within.startsWith("..") || isAbsolute(within))
  throw Error("PRIVATE_OUTPUT_REQUIRED");
await mkdir(output, { recursive: true });
const save = (name: string, v: unknown) =>
  writeFile(resolve(output, name), JSON.stringify(v, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
await save("preregistration.json", {
  corpusHash: manifest.sha256,
  split,
  caseIds: rows.map((r) => r.fixture.id),
  mode: "synthetic",
  memoryTransport: "frozen_synthetic",
  maxCallsPerArm: 2,
  maxTotalModelCalls: rows.length * 4,
  maxOutputTokensPerArm: 3800,
  remoteWrites: 0,
  independentHumanReview: false,
});
if (!args.includes("--live-model")) {
  await save("report.json", {
    status: "dry_run",
    cases: rows.length,
    attempts: 0,
    independentHumanReview: false,
    groundingImprovementConfirmed: false,
    predictiveClaim: false,
  });
  console.log(
    JSON.stringify({ status: "dry_run", cases: rows.length, output }),
  );
} else {
  config({ path: value("env-file") ?? ".env", quiet: true });
  const model = parseLlmConfig(process.env);
  const reports = [];
  for (const row of rows) {
    const source: ResearchSource = {
      id: row.current.id,
      kind: row.current.kind === "news" ? "background" : row.current.kind,
      text: row.current.text,
      url: "https://example.invalid/synthetic/current",
      retrievedAt: row.fixture.knownAt,
      confirmsLineup: row.current.confirmsLineup,
    };
    let index = 0;
    reports.push(
      await runRuntimeAblations({
        fixture: row.fixture,
        seed: "pick-review-memory-pair-v1",
        modelVersion: model.model,
        arms: ["current_memory", "no_memory"],
        currentEvidence: {
          marketSource: {
            id: "market",
            kind: "market",
            text: "Synthetic binary market fixture; no real trade or current event claim.",
            url: "https://example.invalid/synthetic/market",
            retrievedAt: row.fixture.knownAt,
          },
          independent: [source],
        },
        lessonsForMemories: (accepted) =>
          accepted.some(
            (m) => m.id === row.lesson.id && m.version === row.lesson.version,
          )
            ? [row.lesson]
            : [],
        plan: createOfficialPlanner(process.env),
        generate: createOfficialGenerator(process.env),
        recall: async () => structuredClone(row.fixture.memories),
        memoryTransport: "frozen_synthetic",
        onTrace: (trace) => save(`${row.fixture.id}-${++index}.json`, trace),
      }),
    );
  }
  const attempts = reports.flatMap((r) => r.traces);
  await save("report.json", {
    status: "actual_model_synthetic_runtime",
    modelVersion: model.model,
    corpusHash: manifest.sha256,
    split,
    attempts: attempts.length,
    failures: attempts.filter((a) => a.failure).length,
    pairs: reports.map((r) => ({
      arms: r.traces.map((t) => ({
        arm: t.arm,
        toolTrace: t.toolTrace,
        failure: t.failure,
        latencyMs: t.latencyMs,
        tokens: t.tokens,
        costUsd: t.costUsd,
        proposalProduced: t.proposalProduced,
      })),
      questionMatched: new Set(r.traces.map((t) => t.questionHash)).size === 1,
      evidenceMatched: new Set(r.traces.map((t) => t.evidenceHash)).size === 1,
    })),
    memoryTransport: "frozen_synthetic",
    remoteWrites: 0,
    independentHumanReview: false,
    groundingImprovementConfirmed: false,
    predictiveClaim: false,
  });
  console.log(
    JSON.stringify({
      status: "actual_model_synthetic_runtime",
      cases: rows.length,
      attempts: attempts.length,
      failures: attempts.filter((a) => a.failure).length,
      output,
    }),
  );
  if (attempts.some((a) => a.failure)) process.exitCode = 1;
}
