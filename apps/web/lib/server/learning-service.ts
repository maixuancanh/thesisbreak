import "server-only";
import { reportServiceFailure } from "./service-failure";
import { Pool } from "pg";
import { z } from "zod";
import { requireUser, assertMutationOrigin, AuthError } from "./auth";
import { DomainConflict } from "../../../../packages/domain/src/index";
import {
  listLearningCandidates,
  reviewLessonCandidate,
} from "../../../../packages/db/src/experience-learning";
let pool: Pool | undefined;
const json = (v: unknown, status = 200) =>
  Response.json(v, { status, headers: { "Cache-Control": "no-store" } });
async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, "INVALID_INPUT");
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw new AuthError(413, "BODY_TOO_LARGE");
      }
      parts.push(r.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new AuthError(400, "INVALID_INPUT");
    }
  } finally {
    reader.releaseLock();
  }
}
export async function learningCandidateOperation(
  request: Request,
  id?: string,
) {
  try {
    const user = await requireUser();
    if (id) assertMutationOrigin(request);
    if (!process.env.DATABASE_URL)
      throw new AuthError(503, "DATABASE_NOT_CONFIGURED");
    const db = (pool ??= new Pool({
      connectionString: process.env.DATABASE_URL,
      allowExitOnIdle: true,
    }));
    if (!id) return json({ data: await listLearningCandidates(db, user.id) });
    return json(
      await reviewLessonCandidate(
        db,
        user.id,
        z.uuid().parse(id),
        await readBody(request),
      ),
    );
  } catch (e) {
    if (e instanceof AuthError) return json({ error: e.message }, e.status);
    if (e instanceof z.ZodError) return json({ error: "INVALID_INPUT" }, 400);
    if (e instanceof DomainConflict) return json({ error: e.message }, 409);
    if (e instanceof Error && e.message === "NOT_FOUND")
      return json({ error: "NOT_FOUND" }, 404);
    reportServiceFailure("learning", e);
    return json({ error: "LEARNING_UNAVAILABLE" }, 503);
  }
}
