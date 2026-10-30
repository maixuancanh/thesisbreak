import { boundedJson } from "../../../../lib/server/bounded-json";
import { Pool } from "pg";
import { z } from "zod";
import {
  requireUser,
  assertMutationOrigin,
  AuthError,
} from "../../../../lib/server/auth";
import { listConfirmedActions } from "../../../../../../packages/db/src/action-history";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let pool: Pool | undefined;
export async function GET() {
  return handle();
}
export async function POST(request: Request) {
  return handle(request);
}
async function handle(request?: Request) {
  const json = (x: unknown, status = 200) =>
    Response.json(x, { status, headers: { "Cache-Control": "no-store" } });
  try {
    const user = await requireUser();
    if (!process.env.DATABASE_URL) throw Error("DATABASE_UNAVAILABLE");
    pool ??= new Pool({
      connectionString: process.env.DATABASE_URL,
      allowExitOnIdle: true,
    });
    if (request) {
      assertMutationOrigin(request);
      const input = await boundedJson(request, 300);
      const x = z
        .object({ memoryConsent: z.boolean(), confirmed: z.literal(true) })
        .strict()
        .parse(input);
      await pool.query(
        "INSERT INTO action_memory_preferences(user_id,memory_consent) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET memory_consent=EXCLUDED.memory_consent",
        [user.id, x.memoryConsent],
      );
      return json({ saved: true });
    }
    const preference = (
      await pool.query(
        "SELECT memory_consent FROM action_memory_preferences WHERE user_id=$1",
        [user.id],
      )
    ).rows[0];
    return json({
      data: await listConfirmedActions(pool, user.id),
      memoryConsent: preference?.memory_consent ?? false,
    });
  } catch (e) {
    return json(
      {
        error:
          e instanceof AuthError
            ? e.message
            : e instanceof z.ZodError
              ? "INVALID_INPUT"
              : "ACTION_HISTORY_UNAVAILABLE",
      },
      e instanceof AuthError ? e.status : e instanceof z.ZodError ? 400 : 503,
    );
  }
}
