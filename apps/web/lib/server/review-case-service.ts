import "server-only";
import { z } from "zod";
import { listReviewCases } from "../../../../packages/db/src/review-cases";
import { readDecisionEvidenceAssessments } from "../../../../packages/db/src/decision-evidence-assessments";
import {
  listReviewFollowups,
  setReviewFollowup,
} from "../../../../packages/db/src/review-followups";
import { monitoringOperation } from "./pick-monitoring-http";
import { AuthError } from "./auth";
const action = z
  .object({
    caseRevision: z.number().int().positive(),
    action: z.enum(["acknowledge", "snooze", "stop"]),
    dueAt: z.iso.datetime({ offset: true }).optional(),
    timezone: z.string().min(1).max(100).optional(),
  })
  .strict();
function enabled() {
  if (process.env.THESISBREAK_ACCOUNTABILITY_ENABLED !== "true")
    throw new AuthError(503, "ACCOUNTABILITY_DISABLED");
}
export function reviewCasesOperation(request: Request) {
  return monitoringOperation(request, async (pool, ownerId) => {
    enabled();
    const url = new URL(request.url);
    const options = z
      .object({ afterId: z.string().min(1).max(300).optional() })
      .parse({ afterId: url.searchParams.get("cursor") ?? undefined });
    const result = await listReviewCases(
      pool,
      ownerId,
      options.afterId ? { afterId: options.afterId } : {},
    );
    const assessments = await Promise.all(
      result.items.map(async (reviewCase) => ({
        caseId: reviewCase.id,
        items: await readDecisionEvidenceAssessments(
          pool,
          ownerId,
          reviewCase.id,
          reviewCase.revision,
        ),
      })),
    );
    return { ...result, assessments };
  });
}
export function reviewFollowupsOperation(
  request: Request,
  followupId?: string,
) {
  return monitoringOperation(request, async (pool, ownerId, body) => {
    enabled();
    if (request.method === "GET") {
      const rows = await listReviewFollowups(pool, ownerId);
      return {
        items: rows.map((row) => ({
          id: row.id,
          caseId: row.case_id,
          caseRevision: row.case_revision,
          pickId: row.pick_id,
          reasonId: row.reason_id,
          state: row.state,
          dueAt: row.due_at ? new Date(row.due_at).toISOString() : null,
        })),
      };
    }
    const id = z.string().min(1).max(300).parse(followupId);
    const input = action.parse(body);
    try {
      const row = await setReviewFollowup(pool, ownerId, id, input);
      return { id: row.id, state: row.state };
    } catch (error) {
      if (
        error instanceof Error &&
        ["INVALID_SNOOZE", "INVALID_TIMEZONE"].includes(error.message)
      )
        throw new AuthError(422, error.message);
      throw error;
    }
  });
}
