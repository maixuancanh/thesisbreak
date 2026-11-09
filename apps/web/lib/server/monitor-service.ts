import "server-only";
import { Pool } from "pg";
import { z } from "zod";
import { requireUser, assertMutationOrigin, AuthError } from "./auth";
import {
  createMonitor,
  controlMonitor,
  monitorInbox,
} from "../../../../packages/db/src/market-monitors";
import { monitorCreateSchema } from "../../../../packages/domain/src/market-monitor";
import { DomainConflict } from "../../../../packages/domain/src/index";
let pool: Pool | undefined;
const database = () => {
  if (!process.env.DATABASE_URL)
    throw new AuthError(503, "DATABASE_NOT_CONFIGURED");
  return (pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    allowExitOnIdle: true,
  }));
};
export async function monitorOperation(
  request: Request,
  operation: "list" | "create" | "control",
) {
  const json = (v: unknown, status = 200) =>
    Response.json(v, { status, headers: { "Cache-Control": "no-store" } });
  try {
    const user = await requireUser();
    if (operation === "list")
      return json(await monitorInbox(database(), user.id));
    assertMutationOrigin(request);
    const reader = request.body?.getReader();
    if (!reader) throw new AuthError(400, "INVALID_INPUT");
    let text = "",
      size = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const p = await reader.read();
        if (p.done) break;
        size += p.value.byteLength;
        if (size > 16384) {
          await reader.cancel();
          throw new AuthError(413, "BODY_TOO_LARGE");
        }
        text += decoder.decode(p.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new AuthError(400, "INVALID_INPUT");
    }
    if (operation === "create") {
      const input = monitorCreateSchema.parse(value);
      return json(await createMonitor(database(), user.id, input), 201);
    }
    const input = z
      .object({
        id: z.uuid(),
        action: z.enum(["paused", "read"]),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(value);
    return json(
      await controlMonitor(database(), user.id, input.id, input.action),
    );
  } catch (e) {
    if (e instanceof AuthError) return json({ error: e.message }, e.status);
    if (e instanceof z.ZodError) return json({ error: "INVALID_INPUT" }, 400);
    if (e instanceof DomainConflict) return json({ error: e.message }, 409);
    if (e instanceof Error && e.message === "NOT_FOUND")
      return json({ error: "NOT_FOUND" }, 404);
    return json({ error: "MONITOR_UNAVAILABLE" }, 503);
  }
}
