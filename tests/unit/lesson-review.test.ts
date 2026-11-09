import { describe, it, expect } from "vitest";
import {
  lessonCreateSchema,
  lessonUpdateSchema,
  lessonReceipt,
} from "../../packages/domain/src/lesson-review";
const input = {
  requestId: "fd5ed377-53bd-4bfd-ab5d-56a2c3779b87",
  rule: "Wait for an official lineup",
  scope: { domain: "Sports" },
  confirmed: true,
  memoryConsent: true,
};
describe("explicit lesson review", () => {
  it("requires renewed remote consent when resuming a preference", () => {
    const resume = {
      requestId: input.requestId,
      baseVersion: 2,
      action: "active",
      confirmed: true,
    };
    expect(lessonUpdateSchema.safeParse(resume).success).toBe(false);
    expect(
      lessonUpdateSchema.safeParse({ ...resume, memoryConsent: true }).success,
    ).toBe(true);
  });
  it("requires separate approval and remote-storage consent", () => {
    expect(lessonCreateSchema.safeParse(input).success).toBe(true);
    for (const bad of [
      { ...input, confirmed: false },
      { ...input, memoryConsent: false },
      { ...input, userId: "foreign" },
      { ...input, rule: "  " },
      { ...input, scope: { domain: "Sports", allUsers: true } },
    ])
      expect(lessonCreateSchema.safeParse(bad).success).toBe(false);
  });
  it("binds edits to the version reviewed and allows stop without new remote consent", () => {
    expect(
      lessonUpdateSchema.safeParse({
        requestId: input.requestId,
        baseVersion: 1,
        action: "paused",
        confirmed: true,
      }).success,
    ).toBe(true);
    expect(
      lessonUpdateSchema.safeParse({
        requestId: input.requestId,
        baseVersion: 1,
        action: "edit",
        confirmed: true,
        rule: "new",
        scope: { domain: "Sports" },
      }).success,
    ).toBe(false);
  });
  it("reuses a receipt only for the exact reviewed payload", () => {
    const first = lessonReceipt(null, input, () => "first");
    expect(lessonReceipt(first, { ...input }, () => "second").requestId).toBe(
      "first",
    );
    expect(
      lessonReceipt(first, { ...input, rule: "Changed rule" }, () => "second")
        .requestId,
    ).toBe("second");
  });
});
