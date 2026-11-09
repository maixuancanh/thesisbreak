import { decisionReceiptOperation } from "../../../../../../lib/server/decision-receipt-service";
export const runtime = "nodejs";
export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  return decisionReceiptOperation((await context.params).runId);
}
