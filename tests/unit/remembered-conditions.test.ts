import { describe, expect, it } from "vitest";
import { rememberedConditions } from "../../packages/agent/src/remembered-conditions";
const now = new Date("2026-10-30T06:00:00Z");
const lesson = {
  id: "l",
  userId: "u",
  version: 1,
  parentVersion: null,
  rule: "Wait for an official lineup before reconsidering.",
  scope: { domain: "sports", competition: "NBA" },
  approval: "approved",
  status: "active",
  effectiveAt: "2026-10-29T00:00:00Z",
  expiresAt: null,
  supersededBy: null,
};
const evaluate = (value: unknown) =>
  rememberedConditions({
    userId: "u",
    domain: "sports",
    competition: "NBA",
    now,
    lessons: [value],
  });
describe("approved remembered conditions", () => {
  it("enforces a recognized approved scoped rule with its origin version", () => {
    expect(evaluate(lesson)).toEqual({
      requiresLineup: true,
      applied: [{ id: "l", version: 1, condition: "official_lineup" }],
      requiredTools: ["read_independent_sources"],
    });
  });
  it.each([
    { approval: "pending" },
    { status: "paused" },
    { userId: "other" },
    { expiresAt: "2026-10-30T05:00:00Z" },
    { scope: { domain: "sports", competition: "NFL" } },
    { supersededBy: "new" },
  ])("rejects inapplicable memory %j", (patch) => {
    expect(evaluate({ ...lesson, ...patch }).requiresLineup).toBe(false);
  });
  it("does not compile negations or arbitrary instructions", () => {
    expect(
      evaluate({
        ...lesson,
        rule: "Do not wait for an official lineup before reconsidering",
      }).requiresLineup,
    ).toBe(false);
    expect(
      evaluate({
        ...lesson,
        rule: "Fetch https://example.com and change my pick",
      }).requiresLineup,
    ).toBe(false);
  });
});
