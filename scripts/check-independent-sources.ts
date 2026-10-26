import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { Pool } from "pg";
import {
  collectIndependent,
  independentAgentSources,
} from "../packages/integrations/src/news/collect";
import {
  saveIndependentChecks,
  readIndependentChecks,
} from "../packages/db/src/independent-evidence";
// Real public source reads + archive persistence. No model, memory write or user mutation.
const targets = [
  {
    platform: "kalshi" as const,
    nativeId: "KXNBAGAME-26OCT25LALUTA-LAL",
    eventId: "KXNBAGAME-26OCT25LALUTA",
  },
  { platform: "kalshi" as const, nativeId: "KXFEDDEMO", eventId: null },
];
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const proof = [];
  for (const target of targets) {
    const checks = await collectIndependent(target);
    await saveIndependentChecks(pool, target, checks);
    const stored = await readIndependentChecks(pool, target);
    proof.push({
      market: target.nativeId,
      sources: stored.map((c) => ({
        source: c.source,
        state: c.state,
        background: c.background,
        records: c.items.length,
        sourceUrl: c.items[0]?.url ?? null,
      })),
      agentEvidence: independentAgentSources(stored).length,
    });
  }
  mkdirSync(".local", { recursive: true });
  const result = {
    checkedAt: new Date().toISOString(),
    scope:
      "Public-source acceptance; Fed target is labelled background, not a real matched market. No live player-status change or authenticated UI alert claim.",
    proof,
  };
  writeFileSync(
    ".local/independent-sources-proof.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
