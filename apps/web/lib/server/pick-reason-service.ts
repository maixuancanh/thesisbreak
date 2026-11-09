import "server-only";
import {
  confirmPickReason,
  readPickReason,
} from "../../../../packages/db/src/pick-reasons";
import { monitoringOperation } from "./pick-monitoring-http";
export function pickReasonOperation(request: Request, pickId: string) {
  return monitoringOperation(request, async (pool, userId, body) => {
    if (request.method === "GET") return readPickReason(pool, userId, pickId);
    const saved = await confirmPickReason(pool, userId, pickId, body);
    try {
      const current = await readPickReason(pool, userId, pickId);
      return {
        ...saved,
        availableConditions: current?.availableConditions ?? [],
      };
    } catch {
      return saved;
    }
  });
}
