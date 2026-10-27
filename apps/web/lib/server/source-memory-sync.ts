import "server-only";
import type { Pool } from "pg";
import {
  claimMemoryOutbox,
  finishMemoryOutbox,
} from "../../../../packages/db/src/memory-outbox";
import { processMemoryClaim } from "../../../../packages/integrations/src/memory-sync";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../../../../packages/integrations/src/memwal";
/** Bounded after-response fast path. Durable outbox + scheduled worker handle retries. */
export async function syncOneOwnedMemory(pool: Pool, userId: string) {
  if (!process.env.MEMWAL_ACCOUNT_ID || !process.env.MEMWAL_DELEGATE_KEY)
    return;
  const claim = await claimMemoryOutbox(pool, 120000, userId);
  if (!claim) return;
  const adapter = new MemwalAdapter(
    officialMemwalClient(parseMemwalConfig(process.env)),
    userId,
  );
  try {
    await finishMemoryOutbox(
      pool,
      claim,
      await processMemoryClaim(claim, adapter),
    );
  } finally {
    adapter.destroy();
  }
}
