import { z } from "zod";
import {
  liveQuerySchema,
  readLiveCatalog,
} from "../../../lib/server/live-catalog";
import { CatalogError } from "../../../../../packages/integrations/src/tatum/catalog";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const input: Record<string, string> = {};
    for (const [key, value] of params) {
      if (Object.hasOwn(input, key))
        return Response.json({ error: "INVALID_QUERY" }, { status: 400 });
      input[key] = value;
    }
    const query = liveQuerySchema.parse(input);
    return Response.json(await readLiveCatalog(query), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const code =
      error instanceof z.ZodError
        ? "INVALID_QUERY"
        : error instanceof CatalogError
          ? error.code
          : "SOURCE_UNAVAILABLE";
    const status = [
      "INVALID_QUERY",
      "INVALID_MARKET_ID",
      "INVALID_CURSOR",
      "CURSOR_FILTER_MISMATCH",
    ].includes(code)
      ? 400
      : code === "MARKET_NOT_FOUND"
        ? 404
        : code.includes("RATE_LIMITED")
          ? 429
          : code === "TATUM_NOT_CONFIGURED"
            ? 503
            : 502;
    return Response.json(
      { error: code },
      {
        status,
        headers: {
          "Cache-Control": "no-store",
          ...(error instanceof CatalogError && error.retryAfterSeconds
            ? { "Retry-After": String(error.retryAfterSeconds) }
            : {}),
        },
      },
    );
  }
}
