import "server-only";
import { reportServiceFailure } from "./service-failure";
import { Pool } from "pg";
import { z } from "zod";
import { requireUser, assertMutationOrigin, AuthError } from "./auth";
import { boundedJson } from "./bounded-json";
import { sourceWatchInputSchema } from "../../../../packages/domain/src/source-watch";
import {
  listSourceWatches,
  setSourceWatchState,
} from "../../../../packages/db/src/source-watches";
import { followSource } from "../../../../packages/integrations/src/source-watch";
import { sourceWatchConfig } from "../../../../packages/integrations/src/source-watch-config";
let pool: Pool | undefined;
function database() {
  if (!process.env.DATABASE_URL)
    throw new AuthError(503, "DATABASE_NOT_CONFIGURED");
  return (pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    allowExitOnIdle: true,
  }));
}
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
function present(w: Record<string, unknown>) {
  return {
    id: w.id,
    eventId: w.event_id,
    url: w.url,
    originId: w.origin_id,
    reason: w.dependency_id,
    state: w.state,
    expiresAt: w.expires_at,
    lastSuccessAt: w.last_success_at ?? null,
    error: w.last_error
      ? "Source check unavailable. Last successful state is retained."
      : null,
    changes: w.sequence,
  };
}
export async function sourceWatchOperation(
  request: Request,
  operation: "list" | "create" | "update",
  id?: string,
) {
  try {
    const user = await requireUser();
    if (operation === "list") {
      const db = database();
      const watches = await listSourceWatches(db, user.id);
      const changes = (
        await db.query(
          `SELECT e.id,e.watch_id,e.before_value,e.after_value,e.observed_at FROM source_change_events e JOIN source_watches w ON w.id=e.watch_id WHERE e.user_id=$1 AND w.user_id=$1 AND w.state<>'deleted' ORDER BY e.observed_at DESC LIMIT 20`,
          [user.id],
        )
      ).rows;
      return json({
        enabled: sourceWatchConfig().enabled,
        data: watches.map(present),
        changes: changes.map((e) => ({
          id: e.id,
          watchId: e.watch_id,
          before: String(e.before_value).slice(0, 2000),
          after: String(e.after_value).slice(0, 2000),
          observedAt: e.observed_at,
        })),
      });
    }
    assertMutationOrigin(request);
    const raw = await boundedJson(request, 8192);
    if (operation === "create")
      return json(
        present(
          await followSource(
            database(),
            user.id,
            sourceWatchInputSchema.parse(raw),
            sourceWatchConfig(),
          ),
        ),
        201,
      );
    const watchId = z.uuid().parse(id);
    const input = z
      .object({ state: z.enum(["active", "paused", "deleted"]) })
      .strict()
      .parse(raw);
    const changed = await setSourceWatchState(
      database(),
      user.id,
      watchId,
      input.state,
    );
    return changed ? json(changed) : json({ error: "NOT_FOUND" }, 404);
  } catch (error) {
    if (error instanceof AuthError)
      return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return json({ error: "INVALID_INPUT" }, 400);
    const code = error instanceof Error ? error.message : "";
    reportServiceFailure("source_watch", error);
    if (["SOURCE_WATCH_CAP", "SOURCE_WATCH_EXPIRY"].includes(code))
      return json({ error: code }, 409);
    if (
      [
        "SOURCE_URL_FORBIDDEN",
        "SOURCE_HTML_REQUIRES_SERVICE_REGISTRATION",
      ].includes(code)
    )
      return json({ error: code }, 400);
    return json(
      {
        error:
          code === "SOURCE_WATCH_DISABLED" ? code : "SOURCE_WATCH_UNAVAILABLE",
      },
      503,
    );
  }
}
