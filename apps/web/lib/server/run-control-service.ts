import "server-only";
import { Pool } from "pg";
import { z } from "zod";
import { requireUser, assertMutationOrigin, AuthError } from "./auth";
import {
  cancelRun,
  readRun,
  cancelRunSchema,
  streamRunEvents,
} from "../../../../packages/db/src/agent-run-control";
import { RunConflict } from "../../../../packages/db/src/agent-runs";
let pool: Pool | undefined;
function db() {
  if (!process.env.DATABASE_URL)
    throw new AuthError(503, "DATABASE_NOT_CONFIGURED");
  return (pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    allowExitOnIdle: true,
  }));
}
const active = new Map<
  string,
  { userId: string; controller: AbortController }
>();
export function registerRunAbort(
  runId: string,
  userId: string,
  controller: AbortController,
) {
  active.set(runId, { userId, controller });
}
export function unregisterRunAbort(runId: string, controller: AbortController) {
  if (active.get(runId)?.controller === controller) active.delete(runId);
}
export function abortOwnedRun(runId: string, userId: string) {
  const entry = active.get(runId);
  if (entry?.userId === userId) entry.controller.abort();
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
function failure(e: unknown) {
  return e instanceof AuthError
    ? json({ error: e.message }, e.status)
    : e instanceof z.ZodError
      ? json({ error: "INVALID_INPUT" }, 400)
      : e instanceof RunConflict
        ? json({ error: e.message }, 409)
        : json({ error: "RUN_UNAVAILABLE" }, 503);
}
async function body(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, "INVALID_JSON");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1024) {
        await reader.cancel();
        throw new AuthError(413, "BODY_TOO_LARGE");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AuthError(400, "INVALID_JSON");
  }
}
export async function runStatus(_request: Request, runId: string) {
  try {
    const user = await requireUser();
    z.uuid().parse(runId);
    const state = await readRun(db(), user.id, runId);
    return state ? json(state) : json({ error: "RUN_NOT_FOUND" }, 404);
  } catch (e) {
    return failure(e);
  }
}
export async function runCancel(request: Request, runId: string) {
  try {
    const user = await requireUser();
    assertMutationOrigin(request);
    z.uuid().parse(runId);
    const input = cancelRunSchema.parse(await body(request));
    const state = await cancelRun(db(), user.id, runId, input);
    if (!state) return json({ error: "RUN_NOT_FOUND" }, 404);
    abortOwnedRun(runId, user.id);
    return json(state);
  } catch (e) {
    return failure(e);
  }
}
export async function runStream(request: Request, runId: string) {
  try {
    const user = await requireUser();
    z.uuid().parse(runId);
    const initial = await readRun(db(), user.id, runId);
    if (!initial) return json({ error: "RUN_NOT_FOUND" }, 404);
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) abort.abort();
    const encoder = new TextEncoder();
    let first = true;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          await streamRunEvents({
            read: async () => {
              if (first) {
                first = false;
                return initial;
              }
              return readRun(db(), user.id, runId);
            },
            emit: (event) => controller.enqueue(encoder.encode(event)),
            signal: abort.signal,
            lastEventId: request.headers.get("last-event-id") ?? "",
          });
        } catch {
          if (!abort.signal.aborted)
            controller.enqueue(
              encoder.encode("event: unavailable\ndata: {}\n\n"),
            );
        } finally {
          request.signal.removeEventListener("abort", onAbort);
          try {
            controller.close();
          } catch {}
        }
      },
      cancel() {
        abort.abort();
        request.signal.removeEventListener("abort", onAbort);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    return failure(e);
  }
}
