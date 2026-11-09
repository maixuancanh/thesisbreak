import { lessonOperation } from "../../../../lib/server/lesson-service";
export const runtime = "nodejs";
export async function PATCH(
  request: Request,
  context: { params: Promise<{ lessonId: string }> },
) {
  return lessonOperation(request, "update", (await context.params).lessonId);
}
