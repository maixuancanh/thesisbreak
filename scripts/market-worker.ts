import "dotenv/config";
import { Pool } from "pg";
import {
  claimMonitor,
  finishMonitor,
} from "../packages/db/src/market-monitors";
import { PublicCatalog } from "../packages/integrations/src/public-catalog";
import { TatumCatalog } from "../packages/integrations/src/tatum/catalog";
import { marketObservationSchema } from "../packages/domain/src/market-monitor";
import { runWorkerLoop } from "../packages/integrations/src/worker-loop";
import { collectIndependent } from "../packages/integrations/src/news/collect";
import { saveIndependentChecks } from "../packages/db/src/independent-evidence";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const shutdown = new AbortController();
pool.on("error", () =>
  console.warn(
    JSON.stringify({ check: "market.database", status: "connection_lost" }),
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
    ...(process.argv.includes("--batch") ? { maxTicks: 5 } : {}),
    onRetry: (retryMs) =>
      console.warn(
        JSON.stringify({ check: "market.worker", status: "retrying", retryMs }),
      ),
    tick: async () => {
      const claim = await claimMonitor(pool);
      if (!claim) {
        return false;
      }
      let observation = null;
      try {
        const market =
          claim.provider === "tatum"
            ? (
                await new TatumCatalog(process.env.TATUM_API_KEY ?? "").get(
                  claim.platform,
                  claim.nativeId,
                )
              ).data
            : (
                await new PublicCatalog().get(claim.platform, claim.nativeId)
              ).data.find(
                (m) => m.id === claim.nativeId && m.platform === claim.platform,
              );
        if (
          !market ||
          market.id !== claim.nativeId ||
          market.platform !== claim.platform
        )
          throw new Error("SOURCE_IDENTITY_MISMATCH");
        observation = marketObservationSchema.parse({
          rules: market.rules,
          prices: market.outcomes.map((o) => ({
            name: o.name,
            price: o.price,
          })),
          sourceUrl:
            "sourceUrl" in market ? market.sourceUrl : market.source.url,
          fetchedAt: market.fetchedAt,
          // Only the public Kalshi parser currently verifies finality. Other
          // provider status vocabularies require their own verified mapping.
          resolution:
            claim.provider === "public" && "resolution" in market
              ? market.resolution
              : null,
        });
      } catch {
        /* Record unavailable source without fabricated evidence. */
      }
      const evidence = claim.independentNews
        ? await collectIndependent({
            platform: claim.platform,
            nativeId: claim.nativeId,
          })
        : [];
      await saveIndependentChecks(
        pool,
        { platform: claim.platform, nativeId: claim.nativeId },
        evidence,
        claim,
      );
      const saved = await finishMonitor(pool, claim, observation);
      console.log(
        JSON.stringify({
          check: "market.monitor",
          sourceAvailable: !!observation,
          saved,
        }),
      );
      return true;
    },
  });
} finally {
  await pool.end();
}
