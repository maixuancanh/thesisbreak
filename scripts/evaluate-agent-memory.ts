import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  memoryBenchmarkCaseSchema,
  evaluationTraceSchema,
  validatePairedTraces,
  scoreMemory,
} from "../packages/domain/src/memory-benchmark";
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const tracePath = arg("traces"),
  output = arg("output");
if (!tracePath || !output) throw Error("TRACES_AND_OUTPUT_REQUIRED");
if (
  process.argv.includes("--sealed") &&
  !process.argv.includes("--allow-sealed-once")
)
  throw Error("SEALED_ACCESS_EXPLICIT_FLAG_REQUIRED");
const corpusText = await readFile(
  "tests/fixtures/agent-memory/cases.jsonl",
  "utf8",
);
const manifest = JSON.parse(
  await readFile("tests/fixtures/agent-memory/split-manifest.json", "utf8"),
);
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
if (digest(corpusText) !== manifest.corpusSha256)
  throw Error("CORPUS_HASH_MISMATCH");
const allowed = new Map<string, string>(
  manifest.cases.map((c: { id: string; split: string }) => [c.id, c.split]),
);
const corpus = new Map(
  corpusText
    .trim()
    .split("\n")
    .map((line) => {
      const c = memoryBenchmarkCaseSchema.parse(JSON.parse(line));
      return [c.id, c] as const;
    }),
);
const raw = await readFile(tracePath, "utf8");
const traces = raw
  .trim()
  .split("\n")
  .map((line) => evaluationTraceSchema.parse(JSON.parse(line)));
for (const trace of traces) {
  if (!corpus.has(trace.fixtureId)) throw Error("UNKNOWN_FIXTURE");
  if (
    allowed.get(trace.fixtureId) === "sealed" &&
    !process.argv.includes("--sealed")
  )
    throw Error("SEALED_CASE_EXCLUDED");
  if (trace.namespace !== corpus.get(trace.fixtureId)!.namespace)
    throw Error("NAMESPACE_MISMATCH");
}
const pair = validatePairedTraces(traces);
const attempts = traces.map((trace) => ({
  fixtureId: trace.fixtureId,
  arm: trace.arm,
  execution: trace.execution,
  failure: trace.failure,
  score: trace.failure
    ? null
    : scoreMemory({
        fixture: corpus.get(trace.fixtureId)!,
        retrieved: trace.retrieved,
        assertions: trace.assertions,
        abstained: trace.abstained,
      }),
}));
await mkdir(output, { recursive: true });
await writeFile(`${output}/raw-traces.jsonl`, raw, { flag: "wx" });
await writeFile(
  `${output}/report.json`,
  JSON.stringify(
    {
      schemaVersion: 1,
      corpusHash: manifest.corpusSha256,
      rawHash: digest(raw),
      completePairs: pair.completePairs,
      failedAttempts: pair.failedAttempts,
      attempts,
      independentHumanReview: false,
      groundingImprovementConfirmed: false,
      predictiveClaim: false,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    attempts: attempts.length,
    completePairs: pair.completePairs,
    failedAttempts: pair.failedAttempts,
    predictiveClaim: false,
  }),
);
