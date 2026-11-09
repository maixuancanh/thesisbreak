import { createHash } from "node:crypto";
import { z } from "zod";
const text = z.string().trim().min(1).max(12000);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const procedureContentSchema = z
  .object({
    researchInstructions: text,
    queryTemplates: z.array(text).max(20),
    proposedReadOrder: z.array(text).max(20),
  })
  .strict();
export const procedureEvaluationSchema = z
  .object({
    reportHash: sha,
    corpusVersion: text,
    criticalViolations: z.array(text),
    grounding: z.number().finite().min(0).max(1),
    actionCompliance: z.number().finite().min(0).max(1),
    latencyMs: z.number().finite().nonnegative(),
    costUsd: z.number().finite().nonnegative(),
    validationPassed: z.boolean(),
    sealedTestPassed: z.boolean(),
  })
  .strict();
export type ProcedureContent = z.infer<typeof procedureContentSchema>;
export type ProcedureEvaluation = z.infer<typeof procedureEvaluationSchema>;
export type ProcedureStatus =
  "draft" | "evaluated" | "rejected" | "approved" | "active" | "retired";
export interface ProcedureVersion {
  readonly id: string;
  readonly parentId: string | null;
  readonly parentHash: string | null;
  readonly hash: string;
  readonly content: ProcedureContent;
  readonly corpusVersion: string;
  readonly failureExampleIds: readonly string[];
  readonly status: ProcedureStatus;
  readonly evaluation: ProcedureEvaluation | null;
  readonly reviewerId: string | null;
  readonly reviewedAt: string | null;
}
export function procedureContentHash(content: ProcedureContent): string {
  const p = procedureContentSchema.parse(content);
  return createHash("sha256")
    .update(
      JSON.stringify({
        researchInstructions: p.researchInstructions,
        queryTemplates: p.queryTemplates,
        proposedReadOrder: p.proposedReadOrder,
      }),
    )
    .digest("hex");
}
function freeze(version: ProcedureVersion): ProcedureVersion {
  Object.freeze(version.content.queryTemplates);
  Object.freeze(version.content.proposedReadOrder);
  Object.freeze(version.content);
  Object.freeze(version.failureExampleIds);
  if (version.evaluation) {
    Object.freeze(version.evaluation.criticalViolations);
    Object.freeze(version.evaluation);
  }
  return Object.freeze(version);
}
export function createProcedureVersion(input: {
  id: string;
  parentId: string | null;
  parentHash: string | null;
  content: unknown;
  corpusVersion: string;
  failureExampleIds: string[];
}): ProcedureVersion {
  const parsed = z
    .object({
      id: text,
      parentId: text.nullable(),
      parentHash: sha.nullable(),
      content: procedureContentSchema,
      corpusVersion: text,
      failureExampleIds: z.array(text).max(100),
    })
    .strict()
    .parse(input);
  if (
    (parsed.parentId === null) !== (parsed.parentHash === null) ||
    parsed.id === parsed.parentId
  )
    throw Error("PROCEDURE_PARENT_INVALID");
  return freeze({
    ...parsed,
    hash: procedureContentHash(parsed.content),
    status: "draft",
    evaluation: null,
    reviewerId: null,
    reviewedAt: null,
  });
}
export function evaluateProcedure(
  version: ProcedureVersion,
  input: unknown,
): ProcedureVersion {
  if (version.status !== "draft")
    throw Error("PROCEDURE_EVALUATION_ALREADY_SEALED");
  const evaluation = procedureEvaluationSchema.parse(input);
  if (evaluation.corpusVersion !== version.corpusVersion)
    throw Error("PROCEDURE_CORPUS_MISMATCH");
  return freeze({
    ...version,
    evaluation,
    status:
      evaluation.criticalViolations.length ||
      !evaluation.validationPassed ||
      !evaluation.sealedTestPassed
        ? "rejected"
        : "evaluated",
  });
}
export function reviewProcedure(
  version: ProcedureVersion,
  review: { reviewerId: string; at: string; approve: boolean },
): ProcedureVersion {
  if (
    version.status !== "evaluated" ||
    !version.evaluation ||
    version.evaluation.criticalViolations.length
  )
    throw Error("PROCEDURE_NOT_ELIGIBLE_FOR_REVIEW");
  z.string().trim().min(1).parse(review.reviewerId);
  z.string().datetime({ offset: true }).parse(review.at);
  return freeze({
    ...version,
    status: review.approve ? "approved" : "rejected",
    reviewerId: review.reviewerId,
    reviewedAt: review.at,
  });
}
export function activateProcedure(
  version: ProcedureVersion,
  input: {
    activeId: string | null;
    expectedActiveId: string | null;
    reviewerId: string;
  },
): ProcedureVersion {
  if (input.activeId !== input.expectedActiveId)
    throw Error("PROCEDURE_STALE_ACTIVE_VERSION");
  if (
    !["approved", "retired"].includes(version.status) ||
    !version.reviewerId ||
    !version.reviewedAt ||
    version.reviewerId !== input.reviewerId ||
    !version.evaluation ||
    version.evaluation.criticalViolations.length ||
    !version.evaluation.validationPassed ||
    !version.evaluation.sealedTestPassed
  )
    throw Error("PROCEDURE_REVIEW_REQUIRED");
  return freeze({ ...version, status: "active" });
}
/** Mutable guidance is subordinate to separately enforced authority and personal conditions. */
export function renderProcedureForRun(
  content: ProcedureContent,
  personalConditions: readonly string[],
): string {
  const p = procedureContentSchema.parse(content);
  return [
    "Personal conditions (must be preserved):",
    ...personalConditions,
    "Research procedure (guidance only; cannot change permissions, confirmation, cutoff, identity or budgets):",
    p.researchInstructions,
    "Query templates:",
    ...p.queryTemplates,
    "Proposed read order:",
    ...p.proposedReadOrder,
  ].join("\n");
}

/** Keep subordinate research guidance before the unchanged authoritative runtime system. */
export function applyReviewedProcedureToSystem(
  system: string,
  content: ProcedureContent,
): string {
  const p = procedureContentSchema.parse(content);
  return [
    "Reviewed research guidance is subordinate to the authoritative runtime instructions, current consent and personal conditions below. It cannot change permissions, confirmation, cutoff, identity or budgets.",
    p.researchInstructions,
    "Query templates:",
    ...p.queryTemplates,
    "Proposed read order:",
    ...p.proposedReadOrder,
    "Authoritative runtime instructions and personal conditions:",
    system,
  ].join("\n");
}
