import { expect, it } from "vitest";
import { replySchemaForCitations } from "../../packages/agent/src/context";
const reply = {
  message: "The evidence is incomplete.",
  evidenceRefs: ["source-a"],
  lessonRefs: [],
  proposedChange: null,
  reasonReview: {
    baseVersion: 1,
    summary: "Unclear",
    claims: [
      {
        claim: "Starter status",
        status: "unclear",
        explanation: "Not confirmed",
        evidenceRefs: ["source-a"],
      },
    ],
  },
};
it("constrains every citation field to the actual supplied IDs, including review and retrospective", () => {
  const schema = replySchemaForCitations({
    evidenceIds: ["source-a"],
    lessonIds: ["lesson-a"],
  });
  expect(schema.safeParse(reply).success).toBe(true);
  expect(
    schema.safeParse({
      ...reply,
      reasonReview: {
        ...reply.reasonReview,
        claims: [
          {
            ...reply.reasonReview.claims[0],
            evidenceRefs: ["invented-source"],
          },
        ],
      },
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      ...reply,
      retrospective: {
        baseVersion: 1,
        summary: "Not settled",
        reasoningLesson: null,
        evidenceRefs: ["https://example.invalid"],
      },
    }).success,
  ).toBe(false);
  expect(schema.safeParse({ ...reply, lessonRefs: ["source-a"] }).success).toBe(
    false,
  );
});
it("allows no citations when no records exist without inventing a sentinel reference", () => {
  const schema = replySchemaForCitations({ evidenceIds: [], lessonIds: [] });
  expect(
    schema.safeParse({
      message: "No evidence.",
      evidenceRefs: [],
      lessonRefs: [],
      proposedChange: null,
    }).success,
  ).toBe(true);
  expect(schema.safeParse(reply).success).toBe(false);
});
