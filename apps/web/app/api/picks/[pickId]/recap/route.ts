import { decisionRecapOperation } from "../../../../../lib/server/decision-recap-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ pickId: string }> }) {
  return decisionRecapOperation(_request, (await context.params).pickId);
}
