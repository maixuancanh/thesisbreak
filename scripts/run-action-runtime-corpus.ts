import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";
import { config } from "dotenv";
import { Pool } from "pg";
import { z } from "zod";
import { actionBenchmarkCaseSchema } from "../packages/domain/src/action-benchmark";
import { runActionRuntimeAblations } from "../packages/agent/src/action-runtime-ablation";
import {
  actionRecallManifestSchema,
  createExactActionRecall,
} from "../packages/agent/src/action-evaluation-walrus";
import {
  createOfficialPlanner,
  createOfficialGenerator,
} from "../packages/agent/src/provider";
import { parseLlmConfig } from "../packages/agent/src/context";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";

if (!process.argv.includes("--live-model"))
  throw Error("EXPLICIT_LIVE_MODEL_OPT_IN_REQUIRED");
const arg = (name: string) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const output = resolve(arg("output") ?? "");
const within = relative(resolve(".local"), output);
if (!within || within.startsWith("..") || isAbsolute(within))
  throw Error("NEW_PRIVATE_OUTPUT_REQUIRED");
const split = z
  .enum(["dev", "validation", "sealed-test"])
  .parse(arg("split") ?? "dev");
if (split === "sealed-test" && !process.argv.includes("--sealed-holdout"))
  throw Error("EXPLICIT_SEALED_HOLDOUT_REQUIRED");
const limit = Number(arg("limit") ?? 1);
if (!Number.isInteger(limit) || limit < 1 || limit > 40)
  throw Error("CASE_LIMIT_1_TO_40");
const transport = z
  .enum(["frozen_synthetic", "fresh_verified_walrus"])
  .parse(arg("memory-transport") ?? "frozen_synthetic");
const corpus = await readFile(
  "tests/fixtures/agent-actions/cases.jsonl",
  "utf8",
);
const manifestBytes = await readFile(
  "tests/fixtures/agent-actions/split-manifest.json",
  "utf8",
);
const manifest = z
  .object({
    corpusSha256: z.string(),
    cases: z.array(
      z.object({
        id: z.string(),
        family: z.string(),
        split: z.string(),
        sha256: z.string(),
      }),
    ),
  })
  .parse(JSON.parse(manifestBytes));
if (hash(corpus) !== manifest.corpusSha256) throw Error("CORPUS_HASH_MISMATCH");
const cases = corpus
  .trim()
  .split("\n")
  .map((line) => {
    const row = actionBenchmarkCaseSchema.parse(JSON.parse(line));
    const entries = manifest.cases.filter((item) => item.id === row.id);
    if (
      entries.length !== 1 ||
      entries[0]!.family !== row.family ||
      entries[0]!.sha256 !== hash(JSON.stringify(JSON.parse(line)))
    )
      throw Error("FROZEN_CASE_HASH_MISMATCH");
    return row;
  });
if (
  new Set(cases.map((row) => row.id)).size !== cases.length ||
  cases.length !== manifest.cases.length
)
  throw Error("MANIFEST_COVERAGE_MISMATCH");
for (const family of new Set(manifest.cases.map((row) => row.family))) {
  if (
    new Set(
      manifest.cases
        .filter((row) => row.family === family)
        .map((row) => row.split),
    ).size !== 1
  )
    throw Error("FAMILY_SPLIT_LEAKAGE");
}
const selected = cases
  .filter((row) =>
    manifest.cases.some(
      (entry) => entry.id === row.id && entry.split === split,
    ),
  )
  .slice(0, limit);
if (!selected.length) throw Error("NO_SELECTED_CASES");
config({ path: arg("env-file") ?? ".env", quiet: true });
const model = parseLlmConfig(process.env);
await mkdir(output, { recursive: false, mode: 0o700 });
const save = (name: string, value: unknown) =>
  writeFile(resolve(output, name), JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
await save("preregistration.json", {
  corpusHash: hash(corpus),
  manifestHash: hash(manifestBytes),
  split,
  caseIds: selected.map((row) => row.id),
  seed: arg("seed") ?? "action-v1",
  modelVersion: model.model,
  dataMode: "synthetic",
  memoryTransport: transport,
  maxCalls: selected.length * 8,
  maxCallsPerArm: 2,
  maxOutputTokensPerArm: 3800,
  remoteWrites: 0,
  independentHumanReview: false,
});
await save("frozen-split-manifest.json", JSON.parse(manifestBytes));
let pool: Pool | undefined;
const adapters = new Map<string, MemwalAdapter>();
try {
  let recallExact;
  if (transport === "fresh_verified_walrus") {
    if (!arg("authorized-records"))
      throw Error("PRIVATE_AUTHORIZED_RECORD_MANIFEST_REQUIRED");
    const records = actionRecallManifestSchema.parse(
      JSON.parse(await readFile(resolve(arg("authorized-records")!), "utf8")),
    );
    await save("authorized-record-manifest.json", records);
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      options: "-c default_transaction_read_only=on",
      statement_timeout: 7000,
    });
    const memwalConfig = parseMemwalConfig(process.env);
    recallExact = createExactActionRecall({
      pool,
      manifest: records,
      adapterForOwner: (ownerId) => {
        if (!adapters.has(ownerId))
          adapters.set(
            ownerId,
            new MemwalAdapter(officialMemwalClient(memwalConfig), ownerId),
          );
        return adapters.get(ownerId)!;
      },
    });
  }
  const reports = [];
  for (const fixture of selected) {
    let index = 0;
    reports.push(
      await runActionRuntimeAblations({
        fixture,
        seed: arg("seed") ?? "action-v1",
        modelVersion: model.model,
        plan: createOfficialPlanner(process.env),
        generate: createOfficialGenerator(process.env),
        memoryTransport: transport,
        ...(recallExact ? { recallExact } : {}),
        onTrace: (trace) => save(`${fixture.id}-${++index}.json`, trace),
      }),
    );
  }
  const summary = {
    cases: selected.length,
    denominator: reports.reduce((n, row) => n + row.denominator, 0),
    failures: reports.reduce((n, row) => n + row.failures, 0),
    reports,
    dataMode: "synthetic",
    remoteWrites: 0,
    groundingImprovementConfirmed: false,
    predictiveClaim: false,
  };
  await save("report.json", summary);
  console.log(
    JSON.stringify({
      cases: summary.cases,
      attempts: summary.denominator,
      failures: summary.failures,
      remoteWrites: 0,
    }),
  );
} catch {
  await save("run-failure.json", {
    failure: "ACTION_CORPUS_RUN_FAILED",
    remoteWrites: 0,
  });
  process.exitCode = 1;
} finally {
  for (const adapter of adapters.values()) adapter.destroy();
  await pool?.end();
}
