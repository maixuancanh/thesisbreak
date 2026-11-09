import { reviewFollowupsOperation } from "../../../../lib/server/review-case-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function PATCH(
  request: Request,
  context: { params: Promise<{ followupId: string }> },
) {
  return reviewFollowupsOperation(request, (await context.params).followupId);
}
