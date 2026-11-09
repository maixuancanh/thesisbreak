import { lessonOperation } from "../../../../lib/server/lesson-service";
export const runtime = "nodejs";
export const GET = (request: Request) => lessonOperation(request, "weekly");
