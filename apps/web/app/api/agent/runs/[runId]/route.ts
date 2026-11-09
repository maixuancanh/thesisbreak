import { runStatus } from "../../../../../lib/server/run-control-service";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  return runStatus(request, (await context.params).runId);
}
