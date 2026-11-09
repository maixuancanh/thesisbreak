/** Restores only the existing labelled acceptance namespace; no database deletion. */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { readMemoryInventory } from "../packages/db/src/memory-recovery";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../packages/integrations/src/memwal";
if (!process.argv.includes("--restore-acceptance-index"))
  throw new Error("Explicit --restore-acceptance-index required");
const state = JSON.parse(readFileSync(".local/memory-journey.json", "utf8"));
if (
  typeof state.userId !== "string" ||
  !state.userId.startsWith("thesisbreak-acceptance-")
)
  throw new Error("ACCEPTANCE_OWNER_REQUIRED");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let adapter: MemwalAdapter | undefined;
try {
  const inventory = await readMemoryInventory(pool, state.userId);
  if (
    !inventory.records.length ||
    inventory.summary.rejectedRecords ||
    inventory.summary.truncated
  )
    throw new Error("INVENTORY_INCOMPLETE");
  adapter = new MemwalAdapter(
    officialMemwalClient(parseMemwalConfig(process.env)),
    state.userId,
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
  const proof = {
    checkedAt: new Date().toISOString(),
    expectedRecords: inventory.records.length,
    completeness: result.completeness,
    missing: "missing" in result ? result.missing.length : null,
    failed: result.failed,
    truncated: result.truncated,
    label:
      "Existing acceptance namespace only; database and account permissions unchanged",
  };
  writeFileSync(".local/recovery-proof.json", JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
  if (result.completeness !== "expected_inventory_verified")
    process.exitCode = 1;
} catch {
  console.log(
    JSON.stringify({
      check: "recovery",
      status: "unavailable",
      completeness: "unknown",
    }),
  );
  process.exitCode = 1;
} finally {
  adapter?.destroy();
  await pool.end();
}
