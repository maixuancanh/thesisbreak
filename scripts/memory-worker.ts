import "dotenv/config";
import { createDatabase } from "../packages/db/src/client";
import {
  claimMemoryOutbox,
  finishMemoryOutbox,
} from "../packages/db/src/memory-outbox";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
import { processMemoryClaim } from "../packages/integrations/src/memory-sync";
import { runWorkerLoop } from "../packages/integrations/src/worker-loop";
// This command intentionally needs an explicit operator flag before enabling remote writes.
if (!process.argv.includes("--enable-remote-writes"))
  throw new Error(
    "Pass --enable-remote-writes to process explicitly consented lessons",
  );
const config = parseMemwalConfig(process.env);
const { pool } = createDatabase(process.env.DATABASE_URL ?? "");
const shutdown = new AbortController();
pool.on("error", () =>
  console.warn(
    JSON.stringify({ check: "memory.database", status: "connection_lost" }),
  ),
);
process.once("SIGINT", () => {
  shutdown.abort();
});
process.once("SIGTERM", () => {
  shutdown.abort();
});
try {
  await runWorkerLoop({
    signal: shutdown.signal,
    once: process.argv.includes("--once"),
    ...(process.argv.includes("--batch") ? { maxTicks: 3 } : {}),
    onRetry: (retryMs) =>
      console.warn(
        JSON.stringify({ check: "memory.worker", status: "retrying", retryMs }),
      ),
    tick: async () => {
      const claim = await claimMemoryOutbox(pool);
      if (!claim) {
        return false;
      }
      const adapter = new MemwalAdapter(
        officialMemwalClient(config),
        claim.userId,
      );
      try {
        const result = await processMemoryClaim(claim, adapter);
        const saved = await finishMemoryOutbox(pool, claim, result);
        console.log(
          JSON.stringify({
            status: result.status,
            saved,
            attempt: claim.attempt,
          }),
        );
      } finally {
        adapter.destroy();
      }
      return true;
    },
  });
} finally {
  await pool.end();
}
