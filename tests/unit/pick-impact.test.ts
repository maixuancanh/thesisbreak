import { describe, it, expect } from "vitest";
import { classifyPickImpact } from "../../packages/domain/src/pick-impact";
const base = {
  sourceAvailable: true,
  inScope: true,
  officialRequired: true,
  officialConfirmed: true,
  materialContradiction: true,
  conditionMet: true,
};
describe("impact state policy", () => {
  it("separates unavailable, rumor, official material changes and unrelated scope", () => {
    expect(classifyPickImpact({ ...base, sourceAvailable: false })).toBe(
      "check_unavailable",
    );
    expect(classifyPickImpact({ ...base, officialConfirmed: false })).toBe(
      "waiting_confirmation",
    );
    expect(classifyPickImpact(base)).toBe("needs_review");
    expect(classifyPickImpact({ ...base, inScope: false })).toBe(
      "still_watching",
    );
    expect(
      classifyPickImpact({
        ...base,
        materialContradiction: null,
        conditionMet: null,
      }),
    ).toBe("waiting_confirmation");
    expect(
      classifyPickImpact({
        ...base,
        materialContradiction: false,
        conditionMet: false,
      }),
    ).toBe("still_watching");
  });
});
