import "server-only";
import { Pool } from "pg";
import { z } from "zod";
import { requireUser, assertMutationOrigin, AuthError } from "./auth";
import { DomainConflict } from "../../../../packages/domain/src/index";
let pool: Pool | undefined;
export function monitoringDatabase() {
  if (!process.env.DATABASE_URL)
    throw new AuthError(503, "DATABASE_NOT_CONFIGURED");
  return (pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    allowExitOnIdle: true,
  }));
}
export async function monitoringBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, "INVALID_INPUT");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > 32768) {
      await reader.cancel();
      throw new AuthError(413, "BODY_TOO_LARGE");
    }
    chunks.push(part.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AuthError(400, "INVALID_INPUT");
  }
}
export async function monitoringOperation(
  request: Request,
  fn: (pool: Pool, userId: string, body: unknown) => Promise<unknown>,
) {
  try {
    if (process.env.PICK_REASON_MONITORING_ENABLED !== "true")
      throw new AuthError(503, "PICK_REASON_MONITORING_DISABLED");
    const user = await requireUser();
    let body: unknown;
    if (request.method !== "GET") {
      assertMutationOrigin(request);
      body = await monitoringBody(request);
    }
    const result = await fn(monitoringDatabase(), user.id, body);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    let status = 503,
      message = "PICK_MONITORING_UNAVAILABLE";
    if (error instanceof AuthError) {
      status = error.status;
      message = error.message;
    } else if (error instanceof z.ZodError || error instanceof SyntaxError) {
      status = 400;
      message = "INVALID_INPUT";
    } else if (error instanceof DomainConflict) {
      status = 409;
      message = error.message;
    } else if (error instanceof Error && error.message === "NOT_FOUND") {
      status = 404;
      message = "NOT_FOUND";
    } else if (
      error instanceof Error &&
      [
        "INVALID_CURSOR",
        "ASSESSMENT_MISMATCH",
        "CONDITION_EVENT_MISMATCH",
      ].includes(error.message)
    ) {
      status = 400;
      message = error.message;
    }
    return Response.json(
      { error: message },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
