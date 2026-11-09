import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { actionBenchmarkCaseSchema, scoreAction } from "../../packages/domain/src/action-benchmark";
const cases = readFileSync("tests/fixtures/agent-actions/cases.jsonl", "utf8").trim().split("\n").map(l => actionBenchmarkCaseSchema.parse(JSON.parse(l)));
const score = (c = cases[0]!, toolEvidence = c.goldTools, overrides = {}) => scoreAction({ fixture: c, toolEvidence, proposal: "review", userConfirmed: false, mutated: false, memoryOwnerId: c.ownerId, memoryVersion: c.memoryVersion, ...overrides });
describe("memory to action benchmark", () => {
  it("contains forty cases, eight per action family", () => { expect(cases).toHaveLength(40); for (const category of new Set(cases.map(c => c.category))) expect(cases.filter(c => c.category === category)).toHaveLength(8); });
  it.each(cases.map(c => [c.id, c] as const))("scores expected action %s", (_, c) => expect(score(c).passed).toBe(true));
  it("does not substitute an explanation for an official source check", () => {
    expect(score(cases[0], [], { proposal: "change_pick" }).violations).toEqual(expect.arrayContaining(["required_check_missing", "confirmation_missing", "required_check_bypass"]));
  });
  it.each(["eventId", "marketId", "outcomeId", "ownerId"] as const)("rejects wrong %s parameters", key => {
    const c = cases[0]!; const report = score(c, c.goldTools.map(t => ({ ...t, [key]: "wrong" })));
    expect(report.passed).toBe(false); expect(report.violations).toContain("required_check_missing");
  });
  it("counts canonical origins rather than domains and rejects unavailable results", () => {
    const c = cases.find(c => c.category === "source_independence")!;
    expect(score(c, c.goldTools.map(t => ({ ...t, originIds: ["same-wire", "same-wire"] }))).violations).toContain("source_independence_missing");
    expect(score(c, c.goldTools.map(t => ({ ...t, status: "unavailable" }))).violations).toContain("tool_unavailable");
  });
  it("rejects stale edited rules, future/stale evidence, and unauthorized mutations", () => {
    const c = cases.find(c => c.category === "freshness")!;
    expect(score(c, c.goldTools.map(t => ({ ...t, memoryVersion: 99 }))).violations).toContain("stale_rule");
    expect(score(c, c.goldTools.map(t => ({ ...t, availableAt: "2026-11-01T18:01:00Z" }))).violations).toContain("future_evidence");
    expect(score(c, c.goldTools.map(t => ({ ...t, availableAt: "2026-11-01T17:00:00Z" }))).violations).toContain("stale_evidence");
    expect(score(c, c.goldTools, { mutated: true }).violations).toContain("unauthorized_mutation");
  });
  it("checks partial order only for dependent tools", () => {
    const independent = cases.find(c => c.category === "freshness")!;
    expect(score(independent, [...independent.goldTools].reverse()).passed).toBe(true);
    const dependent = cases.find(c => c.category === "multi_market_missing")!;
    expect(score(dependent, [...dependent.goldTools].reverse()).violations).toContain("dependency_order");
  });
  it("rejects source check labels without evidence and paused-rule reuse", () => {
    const c = cases[0]!;
    expect(score(c, c.goldTools.map(t => ({ ...t, verifiedChecks: [] }))).violations).toContain("required_check_missing");
    expect(score(c, c.goldTools.map(t => ({ ...t, evidenceIds: [] }))).violations).toContain("ungrounded_tool");
    const paused = cases.find(c => c.memoryStatus === "paused")!;
    expect(score(paused, [{ ...c.goldTools[0]!, ownerId: paused.ownerId, memoryVersion: paused.memoryVersion }]).violations).toContain("paused_rule_used");
  });
});
