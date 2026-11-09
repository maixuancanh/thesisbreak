import { z } from "zod";
const id = z.string().trim().min(1).max(300);
export const checkStatusSchema = z.enum([
  "not_run",
  "passed",
  "failed",
  "unavailable",
  "unsupported",
]);
export type CheckStatus = z.infer<typeof checkStatusSchema>;
export const checkReceiptSchema = z
  .object({
    checkId: id,
    procedureVersionId: id,
    tool: id,
    status: checkStatusSchema,
    evidenceIds: z.array(id).max(100),
    checkedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.status === "passed" && !v.evidenceIds.length)
      c.addIssue({ code: "custom", message: "Passed check requires evidence" });
  });
export type CheckReceipt = z.infer<typeof checkReceiptSchema>;
export const checkProcedureSchema = z
  .object({
    id,
    version: z.number().int().positive(),
    kind: z.enum([
      "official_lineup",
      "resolution_rules",
      "source_disagreement",
    ]),
    allowedTools: z.array(id).min(1).max(20),
    requiredEvidence: z.array(id).min(1).max(20),
    freshnessSeconds: z.number().int().positive().max(604800),
    maxToolCalls: z.number().int().positive().max(20),
    unsupportedBehavior: z.enum(["wait", "report_unsupported"]),
  })
  .strict();
export type CheckProcedure = z.infer<typeof checkProcedureSchema>;
