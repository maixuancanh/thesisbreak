import "server-only";
import { after } from "next/server";
import { syncOneOwnedMemory } from "./source-memory-sync";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import { requireUser, assertMutationOrigin, AuthError } from "./auth";
import { readLiveCatalog } from "./live-catalog";
import { livePageSchema } from "../live-market";
import {
  registerSourceForecast,
  listSourceScores,
  controlSource,
} from "../../../../packages/db/src/source-credibility";
import { sourceCohort } from "../../../../packages/domain/src/source-credibility";
import { DomainConflict } from "../../../../packages/domain/src/proposal";
let pool: Pool | undefined;
const database = () => {
  if (!process.env.DATABASE_URL)
    throw new AuthError(503, "DATABASE_NOT_CONFIGURED");
  return (pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    allowExitOnIdle: true,
  }));
};
const base = z.object({
  platform: z.enum(["kalshi", "polymarket"]),
  nativeId: z.string().min(1).max(128),
  provider: z.enum(["public", "tatum"]).default("public"),
  confirmed: z.literal(true),
  memoryConsent: z.literal(true),
});
const inputSchema = z.discriminatedUnion("kind", [
  base.extend({ kind: z.literal("market_baseline") }).strict(),
  base
    .extend({
      kind: z.literal("user_reported_forecaster"),
      sourceName: z.string().trim().min(1).max(160),
      reference: z
        .url()
        .max(1000)
        .refine((v) => {
          const u = new URL(v);
          return u.protocol === "https:" && !u.username && !u.password;
        }),
      outcome: z.string().min(1).max(256),
      probability: z.number().finite().min(0).max(1).nullable(),
    })
    .strict(),
]);
async function body(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, "INVALID_INPUT");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const p = await reader.read();
      if (p.done) break;
      bytes += p.value.byteLength;
      if (bytes > 8192) {
        await reader.cancel();
        throw new AuthError(413, "BODY_TOO_LARGE");
      }
      chunks.push(p.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AuthError(400, "INVALID_INPUT");
  }
}
export async function sourceOperation(request: Request) {
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  try {
    const user = await requireUser();
    if (request.method === "GET")
      return json({ data: await listSourceScores(database(), user.id) });
    assertMutationOrigin(request);
    if (request.method === "PATCH") {
      const p = z
        .object({
          id: z.string().regex(/^[a-f0-9]{64}$/),
          state: z.enum(["active", "paused"]),
          confirmed: z.literal(true),
        })
        .strict()
        .parse(await body(request));
      return json(await controlSource(database(), user.id, p.id, p.state));
    }
    const input = inputSchema.parse(await body(request));
    const page = livePageSchema.parse(
      await readLiveCatalog({
        platform: input.platform,
        id: input.nativeId,
        provider: input.provider,
        limit: 20,
      }),
    );
    const m = page.data.find(
      (m) => m.platform === input.platform && m.id === input.nativeId,
    );
    if (!m) throw new AuthError(404, "MARKET_NOT_FOUND");
    if (
      m.resolution ||
      ["finalized", "settled", "resolved", "closed"].includes(m.status ?? "")
    )
      throw new DomainConflict("EVENT_ALREADY_STARTED");
    if (m.outcomes.length !== 2 || !m.rules?.trim())
      throw new DomainConflict("BINARY_RULES_REQUIRED");
    const quoted = m.outcomes
      .filter((o) => o.price !== null)
      .sort((a, b) => b.price! - a.price!)[0];
    if (input.kind === "market_baseline" && !quoted)
      throw new DomainConflict("QUOTE_UNAVAILABLE");
    const outcome =
      input.kind === "market_baseline" ? quoted!.name : input.outcome;
    if (!m.outcomes.some((o) => o.name === outcome))
      throw new AuthError(400, "OUTCOME_NOT_IN_MARKET");
    const reference =
      input.kind === "market_baseline" ? m.sourceUrl : input.reference;
    if (!reference) throw new DomainConflict("SOURCE_REFERENCE_REQUIRED");
    const sourceName =
      input.kind === "market_baseline"
        ? `${input.platform === "kalshi" ? "Kalshi" : "Polymarket"} market quotes`
        : input.sourceName;
    const sourceId =
      input.kind === "market_baseline"
        ? `market:${input.platform}`
        : `user-claim:${createHash("sha256")
            .update(
              JSON.stringify([
                new URL(reference).origin,
                sourceName.toLowerCase(),
              ]),
            )
            .digest("hex")}`;
    const result = await registerSourceForecast(database(), user.id, {
      platform: input.platform,
      nativeId: input.nativeId,
      sourceId,
      sourceName,
      kind: input.kind,
      cohort: sourceCohort(m),
      outcome,
      probability:
        input.kind === "market_baseline" ? quoted!.price : input.probability,
      baselineProbability:
        input.kind === "market_baseline"
          ? null
          : (m.outcomes.find((o) => o.name === outcome)?.price ?? null),
      scheduledAt: m.scheduledAt ?? null,
      reference,
      rulesHash: createHash("sha256").update(m.rules).digest("hex"),
      memoryConsent: true,
    });
    after(async () => {
      try {
        await syncOneOwnedMemory(database(), user.id);
      } catch {
        /* Durable retry remains pending. */
      }
    });
    return json(result, 201);
  } catch (e) {
    if (e instanceof AuthError) return json({ error: e.message }, e.status);
    if (e instanceof z.ZodError) return json({ error: "INVALID_INPUT" }, 400);
    if (e instanceof DomainConflict) return json({ error: e.message }, 409);
    if (e instanceof Error && e.message === "NOT_FOUND")
      return json({ error: "NOT_FOUND" }, 404);
    return json({ error: "SOURCE_HISTORY_UNAVAILABLE" }, 503);
  }
}
