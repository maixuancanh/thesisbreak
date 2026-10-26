import { runStream } from "../../../../../../lib/server/run-control-service";
export const runtime = "nodejs";
export const maxDuration = 30;
export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  return runStream(request, (await context.params).runId);
}
