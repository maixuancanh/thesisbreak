import { z } from "zod";
import { marketIdentitySchema } from "./market";
export const versionFields = {
  version: z.number().int().positive(),
  parentVersion: z.number().int().positive().nullable(),
};
export function validAncestry(v: {
  version: number;
  parentVersion: number | null;
}) {
  return v.version === 1
    ? v.parentVersion === null
    : v.parentVersion === v.version - 1;
}
export const assumptionSchema = z
  .object({ id: z.string().min(1), text: z.string().min(1) })
  .strict();
export const pickVersionSchema = z
  .object({
    userId: z.string().min(1),
    pickId: z.string().min(1),
    ...versionFields,
    market: marketIdentitySchema,
    outcome: z.string().min(1),
    reason: z.string().optional(),
    assumptions: z.array(assumptionSchema).default([]),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .refine(validAncestry, "INVALID_ANCESTRY");
export const watchPlanSchema = z
  .object({
    id: z.string().min(1),
    pickId: z.string().min(1),
    pickVersion: z.number().int().positive(),
    ...versionFields,
    condition: z
      .object({
        kind: z.enum(["lineup_changed", "assumption_changed"]),
        assumptionId: z.string().min(1),
      })
      .strict(),
    sourceIds: z.array(z.string().min(1)).min(1),
    procedureVersion: z.string().min(1),
    deadline: z.iso.datetime(),
    timezone: z.string().refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "INVALID_TIMEZONE"),
    channel: z.literal("in_app"),
    approvedAt: z.iso.datetime().nullable(),
    state: z.enum(["draft", "active", "paused", "archived"]),
  })
  .strict()
  .refine(validAncestry, "INVALID_ANCESTRY")
  .refine(
    (v) =>
      v.state !== "active" ||
      (v.approvedAt !== null &&
        Date.parse(v.deadline) > Date.parse(v.approvedAt)),
    "APPROVAL_AND_FUTURE_DEADLINE_REQUIRED",
  );
