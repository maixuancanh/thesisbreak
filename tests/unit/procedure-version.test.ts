import { describe, expect, it } from "vitest";
import {
  createProcedureVersion,
  evaluateProcedure,
  reviewProcedure,
  activateProcedure,
  renderProcedureForRun,
  procedureContentSchema,
} from "../../packages/domain/src/procedure-version";
const content = {
  researchInstructions: "Verify original sources",
  queryTemplates: ["{event} official update"],
  proposedReadOrder: ["official", "independent"],
};
const draft = () =>
  createProcedureVersion({
    id: "v2",
    parentId: "v1",
    parentHash: "a".repeat(64),
    content,
    corpusVersion: "corpus1",
    failureExampleIds: ["failure1"],
  });
const report = {
  reportHash: "b".repeat(64),
  corpusVersion: "corpus1",
  criticalViolations: [],
  grounding: 1,
  actionCompliance: 1,
  latencyMs: 20,
  costUsd: 0,
  validationPassed: true,
  sealedTestPassed: true,
};
describe("reviewed procedure lifecycle", () => {
  it("rejects mutation of authority fields and preserves immutable content hashes", () => {
    expect(() =>
      procedureContentSchema.parse({ ...content, requireConfirmation: false }),
    ).toThrow();
    const input = { ...content, queryTemplates: [...content.queryTemplates] };
    const version = createProcedureVersion({
      id: "v2",
      parentId: "v1",
      parentHash: "a".repeat(64),
      content: input,
      corpusVersion: "corpus1",
      failureExampleIds: [],
    });
    input.queryTemplates.push("mutated");
    expect(version.content.queryTemplates).toHaveLength(1);
    expect(Object.isFrozen(version.content)).toBe(true);
    expect(version.hash).toBe(draft().hash);
  });
  it("critical failures reject promotion regardless of averages", () => {
    const rejected = evaluateProcedure(draft(), {
      ...report,
      criticalViolations: ["confirmation_bypass"],
    });
    expect(rejected.status).toBe("rejected");
    expect(() =>
      reviewProcedure(rejected, {
        reviewerId: "admin",
        at: "2026-11-02T00:00:00Z",
        approve: true,
      }),
    ).toThrow();
  });
  it("requires passing sealed validation and reviewer before compare-and-swap activation", () => {
    expect(() =>
      reviewProcedure(draft(), {
        reviewerId: "admin",
        at: "2026-11-02T00:00:00Z",
        approve: true,
      }),
    ).toThrow();
    const evaluated = evaluateProcedure(draft(), report);
    const approved = reviewProcedure(evaluated, {
      reviewerId: "admin",
      at: "2026-11-02T00:00:00Z",
      approve: true,
    });
    expect(() =>
      activateProcedure(approved, {
        activeId: "v0",
        expectedActiveId: "v1",
        reviewerId: "admin",
      }),
    ).toThrow("STALE");
    expect(
      activateProcedure(approved, {
        activeId: "v1",
        expectedActiveId: "v1",
        reviewerId: "admin",
      }).status,
    ).toBe("active");
    expect(() => evaluateProcedure(evaluated, report)).toThrow();
  });
  it("never drops personal conditions when applying reviewed research instructions", () => {
    const approved = reviewProcedure(evaluateProcedure(draft(), report), {
      reviewerId: "admin",
      at: "2026-11-02T00:00:00Z",
      approve: true,
    });
    const prompt = renderProcedureForRun(approved.content, [
      "Never change my pick without confirmation",
    ]);
    expect(prompt.indexOf("Never change my pick")).toBeLessThan(
      prompt.indexOf(content.researchInstructions),
    );
  });
});
