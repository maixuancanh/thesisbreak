import { z } from "zod";
import {
  reasonReviewSchema,
  retrospectiveSchema,
  outcomeReviewSchema,
} from "../../../packages/domain/src/reason-review";
export const researchResult = z.object({
  reply: z.object({
    reasonReview: reasonReviewSchema.nullable().optional(),
    retrospective: retrospectiveSchema.nullable().optional(),
    message: z.string(),
    evidenceRefs: z.array(z.string()),
    lessonRefs: z.array(z.string()),
    proposedPick: z
      .object({ outcome: z.string(), reason: z.string().max(4000) })
      .nullable()
      .optional(),
    proposedChange: z
      .object({
        baseVersion: z.number(),
        outcome: z.string().nullable(),
        reason: z.string().nullable(),
      })
      .nullable(),
  }),
  trace: z.array(
    z.object({ tool: z.string(), status: z.string(), count: z.number() }),
  ),
  sources: z.array(
    z.object({ id: z.string(), url: z.string(), retrievedAt: z.string() }),
  ),
  usedLessons: z.array(
    z.object({
      id: z.string(),
      version: z.number(),
      rule: z.string(),
      scope: z.unknown(),
    }),
  ),
  pick: z
    .object({
      id: z.string(),
      version: z.number(),
      outcome: z.string(),
      reason: z.string(),
    })
    .nullable(),
  memoryState: z.string(),
  outcomeReview: outcomeReviewSchema.nullable().optional(),
});
export const historyRows = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      message: z.string(),
      status: z.string(),
      result: z.unknown().nullable(),
      created_at: z.string(),
    }),
  ),
});
export type ResearchResult = z.infer<typeof researchResult>;
export type HistoryRow = z.infer<typeof historyRows>["data"][number];
export const toolNames: Record<string, string> = {
  read_independent_sources: "Checked independent sources",
  read_settlement: "Checked final result",
  read_market: "Checked this market",
  read_saved_pick: "Read your saved pick",
  read_approved_lessons: "Checked your approved preferences",
  compare_snapshot: "Compared your saved snapshot",
};
export function transcriptRows(value: unknown) {
  return historyRows.parse(value).data.map((row) => ({
    ...row,
    result: researchResult.safeParse(row.result).success
      ? researchResult.parse(row.result)
      : null,
  }));
}
export function messageIdentity(
  previous: { text: string; requestId: string } | null,
  text: string,
  uuid: () => string,
) {
  return previous?.text === text ? previous : { text, requestId: uuid() };
}
