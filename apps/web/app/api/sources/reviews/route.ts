import { boundedJson } from "../../../../lib/server/bounded-json";
import { Pool } from "pg";
import { z } from "zod";
import { recordSourceFactReview } from "../../../../../../packages/db/src/source-credibility";
import {
  requireUser,
  assertMutationOrigin,
  AuthError,
} from "../../../../lib/server/auth";
import { DomainConflict } from "../../../../../../packages/domain/src/proposal";
import { after } from "next/server";
import { syncOneOwnedMemory } from "../../../../lib/server/source-memory-sync";
export const runtime = "nodejs";
let pool: Pool | undefined;
export async function POST(request: Request) {
  const response = (x: unknown, status = 200) =>
    Response.json(x, { status, headers: { "Cache-Control": "no-store" } });
  try {
    assertMutationOrigin(request);
    const user = await requireUser();
    const input = await boundedJson(request, 12000);
    if (!process.env.DATABASE_URL) throw Error("DATABASE_UNAVAILABLE");
    pool ??= new Pool({
      connectionString: process.env.DATABASE_URL,
      allowExitOnIdle: true,
    });
    const saved = await recordSourceFactReview(pool, user.id, input);
    after(async () => {
      try {
        await syncOneOwnedMemory(pool!, user.id);
      } catch {}
    });
    return response(saved, 201);
  } catch (e) {
    return response(
      {
        error:
          e instanceof AuthError
            ? e.message
            : e instanceof DomainConflict
              ? e.message
              : e instanceof z.ZodError
                ? "INVALID_INPUT"
                : e instanceof Error && e.message === "NOT_FOUND"
                  ? "NOT_FOUND"
                  : "REVIEW_UNAVAILABLE",
      },
      e instanceof AuthError
        ? e.status
        : e instanceof DomainConflict
          ? 409
          : e instanceof z.ZodError
            ? 400
            : e instanceof Error && e.message === "NOT_FOUND"
              ? 404
              : 503,
    );
  }
}
