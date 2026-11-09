import { z } from "zod";
const id = z.string().trim().min(1).max(300),
  rev = z.number().int().positive(),
  at = z.iso.datetime({ offset: true });
export const reviewFollowupStateSchema = z.enum([
  "pending",
  "snoozed",
  "acknowledged",
  "superseded",
  "stopped",
]);
export type ReviewFollowupState = z.infer<typeof reviewFollowupStateSchema>;
export const reviewFollowupSchema = z
  .object({
    id,
    ownerId: id,
    caseId: id,
    caseRevision: rev,
    pickId: id,
    pickVersion: rev,
    reasonId: id,
    reasonVersion: rev,
    channel: z.literal("in_app"),
    state: reviewFollowupStateSchema,
    dueAt: at.nullable(),
    timezone: z
      .string()
      .min(1)
      .max(100)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }),
    deliveredAt: at.nullable(),
    createdAt: at,
  })
  .strict()
  .superRefine((v, c) => {
    if (v.state === "snoozed" && !v.dueAt)
      c.addIssue({ code: "custom", message: "Snooze requires dueAt" });
  });
export type ReviewFollowup = z.infer<typeof reviewFollowupSchema>;
export const reviewFollowupActionSchema = z
  .object({
    action: z.enum(["acknowledge", "snooze", "stop"]),
    expectedRevision: rev,
    dueAt: at.optional(),
    timezone: z.string().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.action === "snooze" && (!v.dueAt || !v.timezone))
      c.addIssue({
        code: "custom",
        message: "Snooze requires time and timezone",
      });
  });
