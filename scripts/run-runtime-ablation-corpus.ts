import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { config } from "dotenv";
import { Pool } from "pg";
import { z } from "zod";
import { memoryBenchmarkCaseSchema } from "../packages/domain/src/memory-benchmark";
import { runRuntimeAblations } from "../packages/agent/src/runtime-ablation";
import {
  createOfficialGenerator,
  createOfficialPlanner,
} from "../packages/agent/src/provider";
import { parseLlmConfig } from "../packages/agent/src/context";
import { selectFrozenCases } from "../packages/domain/src/frozen-corpus-selection";
import {
  createExactMemoryRecall,
  memoryRecallManifestSchema,
} from "../packages/agent/src/memory-evaluation-walrus";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
const transport = z
  .enum(["frozen_synthetic", "fresh_verified_walrus"])
  .parse(
    process.argv
      .find((value) => value.startsWith("--memory-transport="))
      ?.split("=")[1] ?? "frozen_synthetic",
  );
if (!process.argv.includes("--live-model"))
  throw Error("EXPLICIT_LIVE_MODEL_OPT_IN_REQUIRED");
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const output = resolve(arg("output") ?? "");
const within = relative(resolve(".local"), output);
if (!within || within.startsWith("..") || isAbsolute(within))
  throw Error("NEW_PRIVATE_OUTPUT_REQUIRED");
const limit = Number(arg("limit") ?? 1);
if (!Number.isInteger(limit) || limit < 1 || limit > 5)
  throw Error("CASE_LIMIT_1_TO_5");
const corpus = await readFile(
  "tests/fixtures/agent-memory/cases.jsonl",
  "utf8",
);
const manifest = JSON.parse(
  await readFile("tests/fixtures/agent-memory/split-manifest.json", "utf8"),
);
const corpusHash = createHash("sha256").update(corpus).digest("hex");
if (corpusHash !== manifest.corpusSha256) throw Error("CORPUS_HASH_MISMATCH");
const split = arg("split") ?? "dev";
if (!["dev", "validation", "sealed-test", "all_unsealed"].includes(split))
  throw Error("UNKNOWN_SPLIT");
const offset = Number(arg("offset") ?? 0);
const cases = selectFrozenCases(corpus, manifest, {
  split: split as "dev" | "validation" | "sealed-test" | "all_unsealed",
  allowSealed: process.argv.includes("--sealed"),
  limit,
  offset,
}).map((c) => memoryBenchmarkCaseSchema.parse(c));
if (!cases.length) throw Error("NO_SELECTED_CASES");
config({ path: arg("env-file") ?? ".env", quiet: true });
const model = parseLlmConfig(process.env);
await mkdir(output, { recursive: false });
const save = (name: string, data: unknown) =>
  writeFile(resolve(output, name), JSON.stringify(data, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
await save("preregistration.json", {
  corpusHash,
  split,
  offset,
  limit,
  caseIds: cases.map((c) => c.id),
  seed: arg("seed") ?? "fixed-v1",
  modelVersion: model.model,
  maxCalls: cases.length * 8,
  dataMode: "synthetic",
  memoryTransport: transport,
  remoteWrites: 0,
  independentHumanReview: false,
  predictiveClaim: false,
});
await save("frozen-split-manifest.json", manifest);
const reports = [];
let pool: Pool | undefined;
const adapters = new Map<string, MemwalAdapter>();
let exactRecall: ReturnType<typeof createExactMemoryRecall> | undefined;
let setupFailed = false;
if (transport === "fresh_verified_walrus") {
  try {
    if (!arg("authorized-records"))
      throw Error("PRIVATE_AUTHORIZED_RECORD_MANIFEST_REQUIRED");
    const records = memoryRecallManifestSchema.parse(
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
    let proofIndex = 0;
    exactRecall = createExactMemoryRecall({
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
      onProof: (proof) =>
        save(`fresh-recall-proof-${++proofIndex}.json`, proof),
    });
  } catch {
    setupFailed = true;
    await save("fresh-recall-setup-failure.json", {
      failure: "FRESH_WALRUS_SETUP_FAILED",
      remoteWrites: 0,
    });
  }
}
try {
  for (const fixture of cases) {
    let index = 0;
    reports.push(
      await runRuntimeAblations({
        fixture,
        seed: arg("seed") ?? "fixed-v1",
        modelVersion: model.model,
        plan: createOfficialPlanner(process.env),
        generate: createOfficialGenerator(process.env),
        recall: async () => {
          if (transport === "frozen_synthetic")
            return structuredClone(fixture.memories);
          if (setupFailed || !exactRecall)
            throw Error("FRESH_WALRUS_SETUP_FAILED");
          return exactRecall(fixture);
        },
        memoryTransport: transport,
        onTrace: (trace) => save(`${fixture.id}-${++index}.json`, trace),
      }),
    );
  }
  await save("report.json", {
    corpusHash,
    reports,
    memoryTransport: transport,
    denominator: reports.reduce((n, report) => n + report.attempts, 0),
    remoteWrites: 0,
    groundingImprovementConfirmed: false,
    predictiveClaim: false,
  });
  console.log(
    JSON.stringify({
      cases: cases.length,
      attempts: reports.reduce((n, r) => n + r.attempts, 0),
      failures: reports.reduce((n, r) => n + r.failures, 0),
      groundingImprovementConfirmed: false,
      predictiveClaim: false,
    }),
  );
} finally {
  for (const adapter of adapters.values()) adapter.destroy();
  await pool?.end();
}
