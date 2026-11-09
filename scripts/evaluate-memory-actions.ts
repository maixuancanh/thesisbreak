import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  actionBenchmarkCaseSchema,
  actionToolSchema,
  scoreAction,
} from "../packages/domain/src/action-benchmark";
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const path = arg("traces"),
  output = arg("output");
if (!path || !output) throw Error("TRACES_AND_OUTPUT_REQUIRED");
const corpus = await readFile(
    "tests/fixtures/agent-actions/cases.jsonl",
    "utf8",
  ),
  manifest = JSON.parse(
    await readFile("tests/fixtures/agent-actions/split-manifest.json", "utf8"),
  );
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
if (hash(corpus) !== manifest.corpusSha256) throw Error("CORPUS_HASH_MISMATCH");
const cases = new Map(
  corpus
    .trim()
    .split("\n")
    .map((line) => {
      const c = actionBenchmarkCaseSchema.parse(JSON.parse(line));
      return [c.id, c] as const;
    }),
);
const traceSchema = z
  .object({
    fixtureId: z.string(),
    namespace: z.string(),
    execution: z.enum(["fixture_mock", "runtime_live"]),
    failure: z.string().nullable(),
    toolEvidence: z.array(actionToolSchema),
    proposal: z.enum([
      "keep",
      "review",
      "insufficient_evidence",
      "change_pick",
    ]),
    userConfirmed: z.boolean(),
    mutated: z.boolean(),
    memoryOwnerId: z.string(),
    memoryVersion: z.number().int().positive(),
  })
  .strict();
const raw = await readFile(path, "utf8");
const traces = raw
  .trim()
  .split("\n")
  .map((l) => traceSchema.parse(JSON.parse(l)));
if (new Set(traces.map((t) => t.fixtureId)).size !== traces.length)
  throw Error("DUPLICATE_ATTEMPT_USE_SEPARATE_RUN");
const attempts = traces.map((t) => {
  const fixture = cases.get(t.fixtureId);
  if (!fixture || fixture.namespace !== t.namespace)
    throw Error("UNKNOWN_OR_FOREIGN_FIXTURE");
  const split = manifest.cases.find(
    (c: { id: string }) => c.id === t.fixtureId,
  )?.split;
  if (split === "sealed" && !process.argv.includes("--allow-sealed-once"))
    throw Error("SEALED_EXCLUDED");
  return {
    fixtureId: t.fixtureId,
    execution: t.execution,
    failure: t.failure,
    score: t.failure ? null : scoreAction({ ...t, fixture }),
  };
});
await mkdir(output, { recursive: true });
await writeFile(`${output}/raw-traces.jsonl`, raw, { flag: "wx" });
await writeFile(
  `${output}/report.json`,
  JSON.stringify(
    {
      schemaVersion: 1,
      corpusHash: hash(corpus),
      rawHash: hash(raw),
      attempts,
      failedAttempts: traces.filter((t) => t.failure !== null).length,
      predictiveClaim: false,
      independentHumanReview: false,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    attempts: attempts.length,
    failures: traces.filter((t) => t.failure).length,
    predictiveClaim: false,
  }),
);
