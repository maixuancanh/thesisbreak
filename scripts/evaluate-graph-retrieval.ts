import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { compareGraphRetrieval } from "../packages/agent/src/graph-retrieval-evaluation";
import { memoryBenchmarkCaseSchema } from "../packages/domain/src/memory-benchmark";
const corpus = await readFile(
  "tests/fixtures/agent-memory/cases.jsonl",
  "utf8",
);
const manifest = JSON.parse(
  await readFile("tests/fixtures/agent-memory/split-manifest.json", "utf8"),
);
if (createHash("sha256").update(corpus).digest("hex") !== manifest.corpusSha256)
  throw Error("CORPUS_HASH_MISMATCH");
const allowed = new Set(
  manifest.cases
    .filter((c: { split: string }) => ["dev", "validation"].includes(c.split))
    .map((c: { id: string }) => c.id),
);
const cases = corpus
  .trim()
  .split(/\r?\n/)
  .map((line) => memoryBenchmarkCaseSchema.parse(JSON.parse(line)))
  .filter((c) => allowed.has(c.id));
const report = {
  corpusSha256: manifest.corpusSha256,
  splits: ["dev", "validation"],
  ...(await compareGraphRetrieval(cases)),
};
await writeFile(
  "docs/graph-retrieval-comparison.json",
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    execution: report.execution,
    cases: report.cases,
    baseline: report.baseline,
    graph: report.graph,
    wrongOwner: report.wrongOwner,
    forbiddenHits: report.forbiddenHits,
  }),
);
