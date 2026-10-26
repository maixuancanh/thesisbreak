import { z } from "zod";
import { catalogOperation } from "../../../lib/server/catalog-service";
import {
  CatalogError,
  catalogQuerySchema,
  marketReferenceSchema,
} from "../../../../../packages/integrations/src/tatum/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const entries: Record<string, unknown> = {};
    for (const [name, value] of params) {
      if (name in entries)
        return Response.json(
          { error: "DUPLICATE_QUERY_PARAMETER" },
          { status: 400 },
        );
      if (name === "limit" || name === "minVolume") {
        if (!value.trim())
          return Response.json({ error: "INVALID_QUERY" }, { status: 400 });
        entries[name] = Number(value);
      } else if (name === "cursor") {
        if (value.length > 1300)
          return Response.json({ error: "INVALID_CURSOR" }, { status: 400 });
        try {
          entries[name] = JSON.parse(value) as unknown;
        } catch {
          return Response.json({ error: "INVALID_CURSOR" }, { status: 400 });
        }
      } else entries[name] = value;
    }
    const query =
      "id" in entries
        ? marketReferenceSchema.parse(entries)
        : catalogQuerySchema.parse(entries);
    return Response.json(await catalogOperation(query), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: "INVALID_QUERY" }, { status: 400 });
    const code =
      error instanceof CatalogError ? error.code : "CATALOG_UNAVAILABLE";
    const status =
      code === "TATUM_NOT_CONFIGURED"
        ? 503
        : code.includes("RATE_LIMITED")
          ? 429
          : code === "MARKET_NOT_FOUND"
            ? 404
            : ["INVALID_MARKET_ID", "CURSOR_FILTER_MISMATCH"].includes(code)
              ? 400
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
