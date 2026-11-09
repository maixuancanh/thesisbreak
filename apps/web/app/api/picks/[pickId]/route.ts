import { pickOperation } from "../../../../lib/server/pick-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ pickId: string }> },
) {
  return pickOperation(request, "detail", (await context.params).pickId);
}
