import { pickOperation } from "../../../../../lib/server/pick-service";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ pickId: string }> },
) {
  return pickOperation(request, "reject", (await context.params).pickId);
}
