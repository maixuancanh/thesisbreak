import { z } from "zod";
export const learningScopeSchema = z
  .object({
    domain: z.string().min(1).max(128),
    competition: z.string().min(1).max(128).optional(),
    marketType: z.string().min(1).max(128).optional(),
    horizon: z.string().min(1).max(128).optional(),
    eventId: z.string().min(1).max(256).optional(),
  })
  .strict();
export const learningConditionSchema = z
  .object({
    type: z.enum([
      "require_official_lineup",
      "require_fresh_quote",
      "compare_saved_snapshot",
      "require_independent_origin",
    ]),
    maxAgeSeconds: z.number().int().min(1).max(86400).optional(),
    minimumOrigins: z.number().int().min(2).max(5).optional(),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.type === "require_fresh_quote" && !v.maxAgeSeconds)
      c.addIssue({ code: "custom", message: "FRESHNESS_REQUIRED" });
    if (v.type === "require_independent_origin" && !v.minimumOrigins)
      c.addIssue({ code: "custom", message: "ORIGIN_COUNT_REQUIRED" });
  });
export const learningAtomSchema = z
  .object({
    id: z.uuid(),
    origin: z.enum([
      "user_statement",
      "tool_result",
      "verified_outcome",
      "injected_memory",
      "framework",
      "assistant",
    ]),
    reference: z.string().min(1).max(512),
    version: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    text: z.string().min(1).max(12000),
    eventId: z.string().max(256).nullable(),
    publishedAt: z.iso.datetime().nullable(),
    occurredAt: z.iso.datetime().nullable(),
    retrievedAt: z.iso.datetime(),
    sourceOrigin: z.string().min(1).max(512),
  })
  .strict();
export const experienceSchema = z
  .object({
    requestId: z.uuid(),
    sessionId: z.uuid(),
    runId: z.uuid(),
    eventId: z.string().min(1).max(256),
    modelVersion: z.string().min(1).max(128),
    promptVersion: z.string().min(1).max(128),
    prerequisites: z.array(z.string().max(1000)).max(20),
    outcome: z.string().max(4000).nullable(),
    atoms: z.array(learningAtomSchema).min(1).max(40),
  })
  .strict();
export const candidateEvidenceSchema = z
  .object({
    atomId: z.uuid(),
    version: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    stance: z.enum(["support", "contradict"]),
    quote: z.string().min(1).max(2000),
  })
  .strict();
export const candidateSchema = z
  .object({
    requestId: z.uuid(),
    kind: z.enum([
      "user_preference",
      "research_procedure",
      "source_observation",
      "forecast_hypothesis",
    ]),
    scope: learningScopeSchema,
    statement: z.string().trim().min(1).max(2000),
    experienceIds: z.array(z.uuid()).min(1).max(20),
    evidence: z.array(candidateEvidenceSchema).min(1).max(40),
    modelVersion: z.string().min(1).max(128),
    promptVersion: z.string().min(1).max(128),
    condition: learningConditionSchema.nullable(),
    consolidationProposal: z
      .object({
        classification: z.enum(["conflict", "scope_change"]),
        relatedId: z.uuid(),
        relatedVersion: z.number().int().positive(),
        relatedEvidence: z.array(candidateEvidenceSchema).min(1).max(10),
      })
      .strict()
      .optional(),
    supersedes: z
      .object({ id: z.uuid(), version: z.number().int().positive() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.condition && v.kind !== "research_procedure")
      c.addIssue({ code: "custom", message: "CONDITION_REQUIRES_PROCEDURE" });
    if (!v.evidence.some((e) => e.stance === "support"))
      c.addIssue({ code: "custom", message: "SUPPORT_REQUIRED" });
  });
export const candidateReviewSchema = z.discriminatedUnion("action", [
  z
    .object({
      requestId: z.uuid(),
      baseVersion: z.number().int().positive(),
      action: z.literal("approve"),
      confirmed: z.literal(true),
      memoryConsent: z.literal(true),
      acknowledgeConflict: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      requestId: z.uuid(),
      baseVersion: z.number().int().positive(),
      action: z.literal("reject"),
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      requestId: z.uuid(),
      baseVersion: z.number().int().positive(),
      action: z.literal("edit"),
      confirmed: z.literal(true),
      statement: z.string().trim().min(1).max(2000),
      scope: learningScopeSchema,
      condition: learningConditionSchema.nullable(),
    })
    .strict(),
]);
export type LearningCandidate = z.infer<typeof candidateSchema>;
export type LearningAtom = z.infer<typeof learningAtomSchema>;
