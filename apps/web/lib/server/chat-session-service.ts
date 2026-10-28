import "server-only";
import { Pool } from "pg";
import { z } from "zod";
import { requireUser, assertMutationOrigin, AuthError } from "./auth";
import {
  createChatSession,
  listChatSessions,
  chatHistory,
  syncChatMemory,
} from "../../../../packages/db/src/chat-sessions";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../../../../packages/integrations/src/memwal";
let pool: Pool;
export function sessionDb() {
  if (!process.env.DATABASE_URL)
    throw new AuthError(503, "DATABASE_NOT_CONFIGURED");
  return (pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    allowExitOnIdle: true,
  }));
}
export async function sessionsGET() {
  try {
    const u = await requireUser();
    return Response.json({ data: await listChatSessions(sessionDb(), u.id) });
  } catch (e) {
    return sessionError(e);
  }
}
export async function sessionsPOST(request: Request) {
  try {
    assertMutationOrigin(request);
    const u = await requireUser();
    const b = z
      .object({ memoryConsent: z.boolean() })
      .strict()
      .parse(await request.json());
    return Response.json(
      await createChatSession(sessionDb(), u.id, b.memoryConsent),
    );
  } catch (e) {
    return sessionError(e);
  }
}
export async function sessionRead(request: Request) {
  try {
    const u = await requireUser();
    const id = z
      .uuid()
      .parse(new URL(request.url).searchParams.get("sessionId"));
    return Response.json({ data: await chatHistory(sessionDb(), u.id, id) });
  } catch (e) {
    return sessionError(e);
  }
}
export async function sessionConsent(request: Request) {
  try {
    assertMutationOrigin(request);
    const u = await requireUser();
    const b = z
      .object({ id: z.uuid(), memoryConsent: z.boolean() })
      .strict()
      .parse(await request.json());
    const r = await sessionDb().query(
      "UPDATE conversations SET memory_consent=$3 WHERE id=$1 AND user_id=$2 RETURNING id",
      [b.id, u.id, b.memoryConsent],
    );
    if (!r.rows.length) throw new AuthError(404, "SESSION_NOT_FOUND");
    return Response.json({ ok: true });
  } catch (e) {
    return sessionError(e);
  }
}
export async function sessionSync(request: Request) {
  try {
    assertMutationOrigin(request);
    const u = await requireUser();
    const a = new MemwalAdapter(
      officialMemwalClient(parseMemwalConfig(process.env)),
      u.id,
    );
    try {
      return Response.json(await syncChatMemory(sessionDb(), a, u.id));
    } finally {
      a.destroy();
    }
  } catch (e) {
    return sessionError(e);
  }
}
function sessionError(e: unknown) {
  return Response.json(
    {
      error:
        e instanceof AuthError
          ? e.message
          : e instanceof z.ZodError
            ? "INVALID_INPUT"
            : e instanceof Error && e.message === "SESSION_NOT_FOUND"
              ? "SESSION_NOT_FOUND"
              : "SESSION_UNAVAILABLE",
    },
    {
      status:
        e instanceof AuthError
          ? e.status
          : e instanceof z.ZodError
            ? 400
            : e instanceof Error && e.message === "SESSION_NOT_FOUND"
              ? 404
              : 503,
    },
  );
}
