import { describe, it, expect } from "vitest";
import {
  confirmPickReasonSchema,
  reasonConditionSchema,
} from "../../packages/domain/src/pick-reason";
const condition = {
  kind: "manual_review",
  subjectId: "event",
  eventIds: ["event"],
  statement: "A reason",
  revisitWhen: "New evidence",
  predicate: { type: "manual" },
  sourcePolicy: "manual",
  validFrom: "2026-11-01T00:00:00Z",
  validUntil: "2026-11-04T00:00:00Z",
};
const submission = {
  requestId: "r",
  basePickVersion: 1,
  reason: "My reason",
  conditions: [condition],
  confirmed: true,
  enableMonitoring: false,
};
describe("confirmed pick reasons", () => {
  it("requires explicit confirmation and rejects unknown owner/mode fields", () => {
    expect(confirmPickReasonSchema.safeParse(submission).success).toBe(true);
    for (const value of [
      { ...submission, confirmed: false },
      { ...submission, ownerId: "other" },
      { ...submission, mode: "live" },
      { ...submission, reason: "x".repeat(4001) },
      { ...submission, conditions: Array(5).fill(condition) },
    ])
      expect(confirmPickReasonSchema.safeParse(value).success).toBe(false);
  });
  it("rejects missing events, inverted time and semantic predicate mismatches", () => {
    for (const value of [
      { ...condition, eventIds: [] },
      { ...condition, validUntil: condition.validFrom },
      { ...condition, kind: "official_lineup" },
      { ...condition, extra: true },
    ])
      expect(reasonConditionSchema.safeParse(value).success).toBe(false);
  });
});
