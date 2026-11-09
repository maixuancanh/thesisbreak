import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { compareGraphRetrieval } from "../../packages/agent/src/graph-retrieval-evaluation";
import { memoryBenchmarkCaseSchema } from "../../packages/domain/src/memory-benchmark";
it("compares both reference retrieval arms and retains zero foreign/forbidden hits", async () => {
  const first = (
    await readFile("tests/fixtures/agent-memory/cases.jsonl", "utf8")
  )
    .trim()
    .split(/\r?\n/)[0]!;
  const report = await compareGraphRetrieval([
    memoryBenchmarkCaseSchema.parse(JSON.parse(first)),
  ]);
  expect(report.cases).toBe(1);
  expect(report.wrongOwner).toBe(0);
  expect(report.forbiddenHits).toBe(0);
  expect(report.rows[0]?.graphIds).toEqual(report.rows[0]?.expected);
  expect(report.execution).toBe("synthetic_reference_adapters");
});
