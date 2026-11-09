import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { memoryBenchmarkCaseSchema, retrievalCounts, scoreMemory, validatePairedTraces } from "../../packages/domain/src/memory-benchmark";
const contents = readFileSync("tests/fixtures/agent-memory/cases.jsonl", "utf8");
const cases = contents.trim().split("\n").map(l => memoryBenchmarkCaseSchema.parse(JSON.parse(l)));
describe("multi-session memory benchmark", () => {
  it("has 60 original cases with frozen family-isolated 30/15/15 splits", () => {
    const manifest = JSON.parse(readFileSync("tests/fixtures/agent-memory/split-manifest.json", "utf8"));
    expect(cases).toHaveLength(60);
    expect(manifest.corpusSha256).toBe(createHash("sha256").update(contents).digest("hex"));
    for (const split of ["dev", "validation", "sealed-test"]) expect(manifest.cases.filter((c: { split: string }) => c.split === split)).toHaveLength(split === "dev" ? 30 : 15);
    const families = new Map<string, string>();
    for (const row of manifest.cases) { expect(families.get(row.family) ?? row.split).toBe(row.split); families.set(row.family, row.split); }
    for (const category of new Set(cases.map(c => c.category))) expect(cases.filter(c => c.category === category)).toHaveLength(10);
  });
  it.each(cases.map(c => [c.id, c] as const))("scores frozen gold %s", (_, c) => {
    expect(scoreMemory({ fixture: c, retrieved: c.memories.filter(m => c.expected.some(e => e.id === m.id && e.version === m.version)), assertions: c.goldAssertions, abstained: c.expectedAbstention }).passed).toBe(true);
  });
  it("rejects fluent assertions with foreign, revoked, future and different-event pointers", () => {
    const c = cases[0]!;
    const s = scoreMemory({ fixture: c, retrieved: c.memories, assertions: c.goldAssertions, abstained: false });
    expect(s.violations).toEqual(expect.arrayContaining(["wrong_owner", "revoked", "future_memory", "wrong_event"]));
    expect(s.passed).toBe(false);
  });
  it("keeps abstention separate from undefined retrieval recall", () => {
    const c = cases.find(c => c.expectedAbstention)!;
    const s = scoreMemory({ fixture: c, retrieved: [], assertions: [], abstained: true });
    expect(s.recallAtK).toBeNull(); expect(s.recallAllAtK).toBeNull(); expect(s.abstentionCorrect).toBe(true);
    expect(scoreMemory({ fixture: c, retrieved: [], assertions: ["invented fact"], abstained: false }).passed).toBe(false);
  });
  it("scores partial recall, precision and version mismatch", () => {
    expect(retrievalCounts(["a", "b"], ["a", "irrelevant"], 2)).toMatchObject({ recallAtK: .5, precisionAtK: .5, recallAllAtK: false });
    const c = cases[0]!;
    expect(scoreMemory({ fixture: c, retrieved: [{ ...c.memories[0]!, version: 99 }], assertions: c.goldAssertions, abstained: false }).violations).toContain("unknown_or_modified_pointer");
    expect(() => retrievalCounts([], [], 0)).toThrow("INVALID_K");
  });
  it("rejects duplicate arms and mismatched budget/model/evidence", () => {
    const t = { schemaVersion: 1, fixtureId: "a", namespace: "eval:test", arm: "current_memory", execution: "fixture_mock", modelVersion: "mock", procedureVersion: "v1", prompt: "q", response: "r", questionHash: "q", evidenceHash: "e", maxCalls: 2, maxOutputTokens: 100, retrieved: [], rejectedHits: [], toolTrace: [], assertions: [], abstained: true, latencyMs: 0, tokens: null, costUsd: null, retryCount: 0, failure: null };
    expect(() => validatePairedTraces([t, t])).toThrow("DUPLICATE_ARM");
    expect(() => validatePairedTraces([t, { ...t, arm: "no_memory", maxCalls: 3 }])).toThrow("UNMATCHED_PAIR:maxCalls");
    expect(validatePairedTraces([t, { ...t, arm: "no_memory", failure: "walrus_down" }]).completePairs).toBe(0);
  });
});
