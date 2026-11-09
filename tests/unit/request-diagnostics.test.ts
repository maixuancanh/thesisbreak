import { expect, it } from "vitest";
import { failureCategory } from "../../apps/web/lib/server/request-diagnostics";
it("classifies fixed citation contract failures without copying arbitrary messages", () => {
  expect(failureCategory(new Error("UNKNOWN_REVIEW_CITATION"))).toBe(
    "citation_validation",
  );
  expect(
    failureCategory(
      new Error("wrapper", { cause: new Error("UNKNOWN_CITATION") }),
    ),
  ).toBe("citation_validation");
  expect(failureCategory(new Error("private payload and credentials"))).toBe(
    "unknown",
  );
});
it("classifies invalid answer claim anchors as citation validation", () => {
  expect(failureCategory(new Error("INVALID_ANSWER_CLAIM"))).toBe(
    "citation_validation",
  );
});
