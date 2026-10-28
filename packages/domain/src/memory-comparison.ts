import { z } from "zod";
import { reasonReviewSchema, retrospectiveSchema } from "./reason-review";

export const comparisonReplySchema = z
  .object({
    message: z.string().min(1).max(12000),
    evidenceRefs: z.array(z.string().min(1).max(256)).max(20),
    lessonRefs: z.array(z.string().min(1).max(256)).max(20),
    reasonReview: reasonReviewSchema.nullable().optional(),
    retrospective: retrospectiveSchema.nullable().optional(),
  })
  .strict();

export const MEMORY_COMPARISON_NOTE =
  "Experimental paired responses under the same supplied context; a difference is not proof of quality improvement. Conversation history is excluded from both responses to prevent recalled lesson leakage.";
const common = {
  experimental: z.literal(true),
  historyPolicy: z.literal("excluded_from_both"),
  note: z.literal(MEMORY_COMPARISON_NOTE),
};
export const memoryComparisonSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...common,
      status: z.literal("compared"),
      withMemory: comparisonReplySchema,
      withoutMemory: comparisonReplySchema,
      lessonVersions: z
        .array(
          z
            .object({
              id: z.string().min(1),
              version: z.number().int().positive(),
            })
            .strict(),
        )
        .max(50),
      sourceVersions: z
        .array(
          z
            .object({
              id: z.string().min(1),
              version: z.number().int().positive(),
            })
            .strict(),
        )
        .max(4)
        .optional(),
      sessionVersions: z
        .array(
          z
            .object({
              sessionId: z.string().min(1),
              version: z.number().int().positive(),
              blobId: z.string().min(1),
            })
            .strict(),
        )
        .max(4)
        .optional(),
      changed: z.boolean(),
    })
    .strict()
    .refine(
      (r) =>
        r.lessonVersions.length +
          (r.sourceVersions?.length ?? 0) +
          (r.sessionVersions?.length ?? 0) >
        0,
      "MEMORY_PROVENANCE_REQUIRED",
    ),
  z
    .object({
      ...common,
      status: z.literal("no_applicable_memory"),
      withMemory: z.null(),
      withoutMemory: z.null(),
      lessonVersions: z.array(z.never()).max(0),
      changed: z.literal(false),
    })
    .strict(),
]);
export type MemoryComparison = z.infer<typeof memoryComparisonSchema>;
export type ComparisonReply = z.infer<typeof comparisonReplySchema>;
