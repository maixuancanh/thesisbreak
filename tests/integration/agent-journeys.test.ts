import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgentJourney, scoreJourney, type JourneyAction } from "../../packages/domain/src/agent-journey";
type Fixture = { id: string; family: string; namespace: string; ownerId: string; eventId: string; now: string; sessions: number; steps: { id: string; actor: "agent" | "synthetic_user"; action: JourneyAction; violations: string[] }[] };
const cases: Fixture[] = readFileSync("tests/fixtures/agent-journeys/cases.jsonl", "utf8").trim().split("\n").map(l => JSON.parse(l));
describe("isolated synthetic environment integration (no DB or live authority)", () => {
  it("contains twelve five-session journeys", () => { expect(cases).toHaveLength(12); for (const c of cases) expect(c.sessions).toBe(5); });
  it.each(cases.map(c => [c.id, c] as const))("replays and restores %s without duplicating effects", (_, c) => {
    let environment = new AgentJourney(c);
    for (const [i, step] of c.steps.entries()) {
      const result = environment.step(step.id, step.actor, step.action);
      expect(result.violations, `${c.id}:${step.id}`).toEqual(step.violations);
      const beforeRetry = environment.checkpoint();
      expect(environment.step(step.id, step.actor, step.action)).toEqual(result);
      expect(environment.checkpoint()).toEqual(beforeRetry);
      if (i === Math.floor(c.steps.length / 2)) environment = new AgentJourney(environment.checkpoint());
    }
    expect(scoreJourney(environment.checkpoint(), c.steps.map(s => ({ stepId: s.id, violations: s.violations }))).passed).toBe(true);
  });
  it("does not grant agent approval and catches changed retry payloads", () => {
    const environment = new AgentJourney(cases[0]!);
    const action: JourneyAction = { type: "consent", enabled: true, reviewer: "synthetic_user" };
    expect(environment.step("unauthorized", "agent", action).violations).toContain("agent_cannot_approve");
    expect(() => environment.step("unauthorized", "agent", { ...action, enabled: false })).toThrow("RETRY_PAYLOAD_MISMATCH");
  });
  it("fails a journey if one critical step is wrong or absent", () => {
    const c = cases[0]!, environment = new AgentJourney(c);
    for (const step of c.steps) environment.step(step.id, step.actor, step.action);
    const expected = c.steps.map(s => ({ stepId: s.id, violations: s.violations }));
    expect(scoreJourney(environment.checkpoint(), [...expected, { stepId: "missing", violations: [] }]).passed).toBe(false);
    expected[0]!.violations = ["intentional_failure"];
    expect(scoreJourney(environment.checkpoint(), expected).passed).toBe(false);
  });
});
