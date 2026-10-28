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
import { syncChatMemory } from "../packages/db/src/chat-sessions";
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
        const next = (
          await pool.query(
            "SELECT m.user_id FROM conversation_memories m JOIN conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id WHERE c.memory_consent=true AND (m.state IN ('pending','retry') OR (m.state='processing' AND m.lease_until<now())) AND (m.retry_at IS NULL OR m.retry_at<=now()) ORDER BY m.recorded_at LIMIT 1",
          )
        ).rows[0];
        if (!next) return false;
        const adapter = new MemwalAdapter(
          officialMemwalClient(config),
          next.user_id,
        );
        try {
          console.log(
            JSON.stringify({
              kind: "session.memory",
              ...(await syncChatMemory(pool, adapter, next.user_id)),
            }),
          );
        } finally {
          adapter.destroy();
        }
        return true;
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
