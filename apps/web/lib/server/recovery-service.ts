import "server-only";
import { Pool } from "pg";
import { z } from "zod";
import { requireUser, assertMutationOrigin, AuthError } from "./auth";
import { readMemoryInventory } from "../../../../packages/db/src/memory-recovery";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../../../../packages/integrations/src/memwal";
let pool: Pool | undefined;
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
export async function recoveryOperation(request: Request, restore = false) {
  let adapter: MemwalAdapter | undefined;
  try {
    const user = await requireUser();
    if (restore) {
      assertMutationOrigin(request);
      const reader = request.body?.getReader();
      if (!reader) throw new AuthError(400, "INVALID_INPUT");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const p = await reader.read();
          if (p.done) break;
          size += p.value.byteLength;
          if (size > 16384) {
            await reader.cancel();
            throw new AuthError(413, "BODY_TOO_LARGE");
          }
          chunks.push(p.value);
        }
      } finally {
        reader.releaseLock();
      }
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new AuthError(400, "INVALID_INPUT");
      }
      z.object({ confirmed: z.literal(true) })
        .strict()
        .parse(raw);
    }
    if (!process.env.DATABASE_URL)
      throw new AuthError(503, "DATABASE_NOT_CONFIGURED");
    pool ??= new Pool({
      connectionString: process.env.DATABASE_URL,
      allowExitOnIdle: true,
    });
    const inventory = await readMemoryInventory(pool, user.id);
    if (!restore) return json(inventory.summary);
    if (inventory.summary.truncated || inventory.summary.rejectedRecords)
      return json({ ...inventory.summary, error: "INVENTORY_INCOMPLETE" }, 409);
    adapter = new MemwalAdapter(
      officialMemwalClient(parseMemwalConfig(process.env)),
      user.id,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      adapter.restore(inventory.records),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("RECOVERY_TIMEOUT")), 90000);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    return json({
      ...inventory.summary,
      completeness: result.completeness,
      missingRecords: "missing" in result ? result.missing.length : null,
      failed: result.failed,
      truncated: result.truncated,
    });
  } catch (e) {
    if (e instanceof AuthError) return json({ error: e.message }, e.status);
    if (e instanceof z.ZodError) return json({ error: "INVALID_INPUT" }, 400);
    return json(
      { error: "RECOVERY_UNAVAILABLE", completeness: "unknown" },
      503,
    );
  } finally {
    adapter?.destroy();
  }
}
