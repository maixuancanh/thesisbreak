import "server-only";
import { Pool } from "pg";
import { z } from "zod";
import { requireUser, assertMutationOrigin, AuthError } from "./auth";
import { DomainConflict } from "../../../../packages/domain/src/index";
import {
  lessonCreateSchema,
  lessonUpdateSchema,
} from "../../../../packages/domain/src/lesson-review";
import {
  createApprovedLesson,
  listLessons,
  updateReviewedLesson,
} from "../../../../packages/db/src/lessons";
import { readWeeklyReview } from "../../../../packages/db/src/weekly-review";
let pool: Pool | undefined;
function database() {
  if (!process.env.DATABASE_URL)
    throw new AuthError(503, "DATABASE_NOT_CONFIGURED");
  return (pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    allowExitOnIdle: true,
  }));
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
async function body(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, "INVALID_INPUT");
  const decoder = new TextDecoder();
  let text = "",
    size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw new AuthError(413, "BODY_TOO_LARGE");
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (e) {
    if (e instanceof AuthError) throw e;
    throw new AuthError(400, "INVALID_INPUT");
  } finally {
    reader.releaseLock();
  }
}
export async function lessonOperation(
  request: Request,
  operation: "list" | "create" | "update" | "weekly",
  id?: string,
) {
  try {
    const user = await requireUser();
    if (operation === "weekly")
      return json(await readWeeklyReview(database(), user.id));
    if (operation === "list")
      return json({ data: await listLessons(database(), user.id) });
    assertMutationOrigin(request);
    const raw = await body(request);
    if (operation === "create") {
      const input = lessonCreateSchema.parse(raw);
      return json(await createApprovedLesson(database(), user.id, input), 201);
    }
    const lessonId = z.uuid().parse(id);
    const input = lessonUpdateSchema.parse(raw);
    return json(
      await updateReviewedLesson(database(), user.id, lessonId, input),
    );
  } catch (e) {
    if (e instanceof AuthError) return json({ error: e.message }, e.status);
    if (e instanceof z.ZodError) return json({ error: "INVALID_INPUT" }, 400);
    if (e instanceof DomainConflict) return json({ error: e.message }, 409);
    if (e instanceof Error && e.message === "NOT_FOUND")
      return json({ error: "NOT_FOUND" }, 404);
    return json({ error: "MEMORY_UNAVAILABLE" }, 503);
  }
}
