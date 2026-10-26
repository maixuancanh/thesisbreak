import "server-only";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import {
  createPick,
  readPicks,
  proposePick,
  confirmPick,
  type Snapshot,
} from "../../../../packages/db/src/picks";
import {
  marketReferenceSchema,
  CatalogError,
} from "../../../../packages/integrations/src/tatum/catalog";
import { DomainConflict } from "../../../../packages/domain/src/index";
import { requireUser, assertMutationOrigin, AuthError } from "./auth";
import { readLiveCatalog } from "./live-catalog";
let pool: Pool | undefined;
function database() {
  if (!process.env.DATABASE_URL)
    throw new AuthError(503, "DATABASE_NOT_CONFIGURED");
  return (pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    allowExitOnIdle: true,
  }));
}
const identity = {
  platform: z.enum(["polymarket", "kalshi"]),
  nativeId: z.string().min(1).max(128),
};
const requestId = z.string().min(1).max(128);
const reason = z.string().trim().min(1).max(4000);
const createSchema = z
  .object({
    ...identity,
    provider: z.enum(["auto", "public", "tatum"]).default("auto"),
    outcome: z.string().min(1).max(256),
    reason: z.string().trim().max(4000).default(""),
    requestId,
  })
  .strict();
export function parsePickCreate(value: unknown) {
  const input = createSchema.parse(value);
  marketReferenceSchema.parse({ platform: input.platform, id: input.nativeId });
  return input;
}
const snapshotInput = z.object({
  platform: z.enum(["polymarket", "kalshi"]),
  id: z.string(),
  eventId: z.string().nullable(),
  question: z.string().min(1),
  outcomes: z
    .array(
      z.object({
        name: z.string().min(1),
        price: z.number().finite().min(0).max(1).nullable(),
      }),
    )
    .min(2),
  rules: z.string().nullable(),
  fetchedAt: z.iso.datetime({ offset: true }),
  priceAsOf: z.iso.datetime({ offset: true }).nullable(),
  closeTime: z.iso.datetime({ offset: true }).nullable(),
  source: z.object({ url: z.url() }),
});
/** Accept only a server catalog result. Client payloads never reach this function. */
export function verifiedSnapshot(value: unknown, outcome: string): Snapshot {
  const s = snapshotInput.parse(value);
  if (!s.outcomes.some((o) => o.name === outcome))
    throw new AuthError(400, "OUTCOME_NOT_IN_MARKET");
  if (!s.rules?.trim()) throw new AuthError(422, "MARKET_RULES_UNAVAILABLE");
  return {
    platform: s.platform,
    nativeId: s.id,
    eventId: s.eventId,
    question: s.question,
    outcomes: s.outcomes,
    rulesReference: s.source.url,
    rulesHash: createHash("sha256").update(s.rules).digest("hex"),
    fetchedAt: s.fetchedAt,
    priceAsOf: s.priceAsOf,
    closeTime: s.closeTime,
    nativeUnit: "probability",
    raw: value,
  };
}
const proposeSchema = z
  .object({
    requestId,
    baseVersion: z.number().int().positive(),
    changes: z
      .object({
        outcome: z.string().min(1).max(256).optional(),
        reason: reason.optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0),
    reason,
  })
  .strict();
const confirmSchema = z
  .object({ requestId, proposalId: z.uuid(), confirmed: z.literal(true) })
  .strict();
export function pickResponse(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
export async function pickOperation(
  request: Request,
  operation: "list" | "detail" | "create" | "propose" | "confirm",
  pickId?: string,
) {
  try {
    const user = await requireUser();
    if (["create", "propose", "confirm"].includes(operation))
      assertMutationOrigin(request);
    if (operation === "list")
      return pickResponse({ data: await readPicks(database(), user.id) });
    if (operation === "detail")
      return pickResponse({
        data: await readPicks(database(), user.id, z.uuid().parse(pickId)),
      });
    // Bound input before JSON parsing. Request streams are consumed with an actual byte cap.
    const reader = request.body?.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 16384) {
            await reader.cancel();
            throw new AuthError(413, "BODY_TOO_LARGE");
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new AuthError(400, "INVALID_JSON");
    }
    if (operation === "create") {
      const input = parsePickCreate(body);
      const result = await createPick(database(), user.id, input, async () => {
        const result = (await readLiveCatalog({
          platform: input.platform,
          id: input.nativeId,
          provider: input.provider,
          limit: 20,
        })) as { data: Record<string, unknown>[]; provider: string };
        const row = result.data[0];
        if (!row || row.id !== input.nativeId || row.platform !== input.platform)
          throw new CatalogError("INVALID_PROVIDER_RESPONSE");
        return verifiedSnapshot({ ...row, catalogProvider: result.provider, priceAsOf: null, source: {url: row.sourceUrl} }, input.outcome);
      });
      return pickResponse(result, 201);
    }
    const id = z.uuid().parse(pickId);
    if (operation === "propose")
      return pickResponse(
        await proposePick(database(), user.id, id, proposeSchema.parse(body)),
        201,
      );
    return pickResponse(
      await confirmPick(database(), user.id, id, confirmSchema.parse(body)),
    );
  } catch (error) {
    if (error instanceof AuthError)
      return pickResponse({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return pickResponse({ error: "INVALID_INPUT" }, 400);
    if (error instanceof DomainConflict)
      return pickResponse({ error: error.message }, 409);
    if (error instanceof CatalogError)
      return pickResponse(
        { error: error.code },
        error.code.includes("RATE_LIMITED")
          ? 429
          : error.code === "MARKET_NOT_FOUND"
            ? 404
            : error.code === "TATUM_NOT_CONFIGURED"
              ? 503
              : 502,
      );
    if (error instanceof Error && error.message === "NOT_FOUND")
      return pickResponse({ error: "NOT_FOUND" }, 404);
    if (error instanceof Error && error.message === "OUTCOME_NOT_IN_MARKET")
      return pickResponse({ error: error.message }, 400);
    return pickResponse({ error: "PICKS_UNAVAILABLE" }, 503);
  }
}
