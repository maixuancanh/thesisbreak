import "server-only";
import {
  listPickReviews,
  recordPickReviewAction,
} from "../../../../packages/db/src/pick-impact";
import { listSharedReasons } from "../../../../packages/db/src/source-lineage";
import { monitoringOperation } from "./pick-monitoring-http";
export function pickReviewOperation(
  request: Request,
  operation: "list" | "shared" | "action",
  reviewId?: string,
) {
  return monitoringOperation(request, (pool, userId, body) => {
    if (operation === "shared") return listSharedReasons(pool, userId);
    if (operation === "action")
      return recordPickReviewAction(pool, userId, reviewId!, body);
    const url = new URL(request.url);
    return listPickReviews(pool, userId, {
      cursor: url.searchParams.get("cursor") ?? undefined,
      reviewId: reviewId ?? url.searchParams.get("reviewId") ?? undefined,
    });
  });
}
