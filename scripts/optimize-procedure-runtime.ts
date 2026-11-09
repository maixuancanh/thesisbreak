import { config } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  runProcedureRuntimeOptimization,
  procedureRuntimeInputSchema,
} from "../packages/agent/src/procedure-runtime-optimizer";

// This check precedes credential loading, directory creation and provider setup.
if (!process.argv.includes("--live-model"))
  throw Error(
    "LIVE_MODEL_OPT_IN_REQUIRED: this command makes bounded model requests using separately consented frozen development data",
  );
const value = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const inputPath = value("--input"),
  outputPath = value("--output"),
  envPath = value("--env-file");
if (!inputPath || !outputPath)
  throw Error(
    "Usage: tsx scripts/optimize-procedure-runtime.ts --live-model --input authorized.json --output new-private-directory [--env-file local.env] [--python path]",
  );
const request = procedureRuntimeInputSchema.parse(
  JSON.parse(await readFile(resolve(inputPath), "utf8")),
);
if (envPath) config({ path: resolve(envPath), override: false, quiet: true });
const directory = resolve(outputPath);
await mkdir(directory, { recursive: false });
const write = (file: string, data: unknown) =>
  writeFile(join(directory, file), JSON.stringify(data, null, 2) + "\n", {
    flag: "wx",
  });
await write("run-metadata.json", {
  modelVersion: request.modelVersion,
  corpusVersion: request.corpusVersion,
  mode: request.mode,
  namespace: "private_procedure_development",
  ownerId: request.ownerId,
  reviewerId: request.reviewerId,
  startedAt: new Date().toISOString(),
  maxCalls: request.maxCalls,
  maxOutputTokens: request.maxOutputTokens,
  productionMutations: 0,
  validationPassed: false,
  sealedTestPassed: false,
  benefitDemonstrated: false,
});
let sequence = 0;
try {
  const report = await runProcedureRuntimeOptimization({
    request,
    python:
      value("--python") ?? resolve("workers/research/.venv/Scripts/python.exe"),
    workerCwd: resolve("workers/research"),
    liveModel: true,
    env: process.env,
    onArtifact: (artifact) =>
      write(`trace-${String(++sequence).padStart(4, "0")}.json`, artifact),
  });
  await write("report.json", report);
  console.log(
    JSON.stringify({
      output: directory,
      method: report.method,
      reservedCalls: report.actualReservedCalls,
      validationPassed: false,
      sealedTestPassed: false,
      benefitDemonstrated: false,
    }),
  );
} catch {
  await write("failure.json", {
    code: "RUNTIME_OPTIMIZATION_FAILED",
    retainedTraceFiles: sequence,
  });
  console.error(
    JSON.stringify({
      output: directory,
      error: "RUNTIME_OPTIMIZATION_FAILED",
      retainedTraceFiles: sequence,
    }),
  );
  process.exitCode = 1;
}
