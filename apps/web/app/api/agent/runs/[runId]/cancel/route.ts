import { runCancel } from "../../../../../../lib/server/run-control-service";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  return runCancel(request, (await context.params).runId);
}
