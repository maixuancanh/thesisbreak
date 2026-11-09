import "server-only";
import { readDecisionRecap } from "../../../../packages/db/src/decision-recaps";
import { monitoringOperation } from "./pick-monitoring-http";
export function decisionRecapOperation(request: Request, pickId: string) {
  return monitoringOperation(request, async (pool, ownerId) => {
    if (
      !(
        await pool.query("SELECT id FROM picks WHERE id=$1 AND user_id=$2", [
          pickId,
          ownerId,
        ])
      ).rowCount
    )
      throw Error("NOT_FOUND");
    return { recap: await readDecisionRecap(pool, ownerId, pickId) };
  });
}
