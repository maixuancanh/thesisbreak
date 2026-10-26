import { it, expect } from "vitest";
import {
  lessonVersionSchema,
  watchPlanSchema,
} from "../../packages/domain/src/index";
const cases = [
  ["2026-10-22T00:00:00Z", "2026-10-22T00:00:00.100Z", true],
  ["2026-10-22T00:00:00.100Z", "2026-10-22T00:00:00Z", false],
  ["2026-10-22T00:00:00Z", "2026-10-22T00:00:00.000Z", false],
  ["2026-10-22T00:00:00.000Z", "2026-10-22T00:00:00Z", false],
] as const;
it.each(cases)("lesson window %s to %s is valid: %s", (start, end, valid) => {
  expect(
    lessonVersionSchema.safeParse({
      id: "l",
      userId: "u",
      version: 1,
      parentVersion: null,
      rule: "Check news",
      scope: { domain: "football" },
      approval: "approved",
      status: "active",
      effectiveAt: start,
      expiresAt: end,
      supersededBy: null,
    }).success,
  ).toBe(valid);
});
it.each(cases)(
  "approved plan window %s to %s is valid: %s",
  (start, end, valid) => {
    expect(
      watchPlanSchema.safeParse({
        id: "w",
        pickId: "p",
        pickVersion: 1,
        version: 1,
        parentVersion: null,
        condition: { kind: "lineup_changed", assumptionId: "a" },
        sourceIds: ["official"],
        procedureVersion: "1",
        deadline: end,
        timezone: "UTC",
        channel: "in_app",
        approvedAt: start,
        state: "active",
      }).success,
    ).toBe(valid);
  },
);
