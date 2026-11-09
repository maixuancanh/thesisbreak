import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  registerSourceForecast,
  settleSourceForecasts,
  listSourceScores,
  controlSource,
} from "../../packages/db/src/source-credibility";
import {
  claimMemoryOutbox,
  finishMemoryOutbox,
} from "../../packages/db/src/memory-outbox";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "source score, correction, consent and memory fencing",
  () => {
    const pool = new Pool({ connectionString: url }),
      u = randomUUID(),
      other = randomUUID(),
      nativeId = `SOURCE-${randomUUID()}`;
    const snapshot = {
      platform: "kalshi" as const,
      nativeId,
      sourceId: "analyst:example",
      sourceName: "Example",
      kind: "user_reported_forecaster" as const,
      cohort: "NBA",
      outcome: "Yes",
      probability: 0.8,
      baselineProbability: 0.5,
      scheduledAt: new Date(Date.now() + 3600000).toISOString(),
      reference: "https://example.com/forecast",
      rulesHash: "fixture",
      memoryConsent: true,
    };
    beforeAll(async () => {
      for (const id of [u, other])
        await pool.query(
          "INSERT INTO users(id,provider_subject) VALUES($1,$1)",
          [id],
        );
    });
    afterAll(async () => {
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [[u, other]]);
      await pool.end();
    });
    it("persists only pre-event claims, queues immutable current scores and retracts corrected results", async () => {
      const result = await registerSourceForecast(pool, u, snapshot);
      expect(await registerSourceForecast(pool, u, snapshot)).toEqual(result);
      await expect(
        registerSourceForecast(pool, u, { ...snapshot, probability: 0.9 }),
      ).rejects.toThrow("SOURCE_FORECAST_LOCKED");
      await expect(
        registerSourceForecast(pool, u, {
          ...snapshot,
          nativeId: "late",
          scheduledAt: new Date(Date.now() - 1000).toISOString(),
        }),
      ).rejects.toThrow("EVENT_ALREADY_STARTED");
      expect(await listSourceScores(pool, other)).toEqual([]);
      let rows = await listSourceScores(pool, u);
      expect(rows[0]?.payload.performance.scored).toBe(0);
      const claim = await claimMemoryOutbox(pool);
      expect(claim?.record.type).toBe("source_credibility");
      expect(claim?.userId).toBe(u);
      // Test-only simulated historical fixture. Production settlement cannot backdate forecasts.
      await pool.query(
        "UPDATE source_forecasts SET recorded_at=now()-interval '3 hours',scheduled_at=now()-interval '2 hours' WHERE user_id=$1",
        [u],
      );
      const resolution = {
        outcome: "Yes",
        resolvedAt: new Date(Date.now() - 3600000).toISOString(),
      };
      await settleSourceForecasts(pool, {
        platform: "kalshi",
        nativeId,
        rulesHash: "fixture",
        reference: "https://kalshi.com/markets/result",
        resolution,
      });
      rows = await listSourceScores(pool, u);
      expect(rows[0]?.payload.performance.scored).toBe(1);
      expect(rows[0]?.payload.performance.matched).toBe(1);
      await settleSourceForecasts(pool, {
        platform: "kalshi",
        nativeId,
        rulesHash: "fixture",
        reference: "https://kalshi.com/markets/result",
        resolution,
      });
      expect((await listSourceScores(pool, u))[0]?.payload.version).toBe(
        rows[0]?.payload.version,
      );
      await settleSourceForecasts(pool, {
        platform: "kalshi",
        nativeId,
        rulesHash: "fixture",
        reference: "https://kalshi.com/markets/result",
        resolution: { ...resolution, outcome: "No" },
      });
      rows = await listSourceScores(pool, u);
      expect(rows[0]?.payload.performance.scored).toBe(1);
      expect(rows[0]?.payload.performance.matched).toBe(0);
      await settleSourceForecasts(pool,{platform:"kalshi",nativeId,rulesHash:"fixture",reference:"https://kalshi.com/markets/result",resolution:null});
      expect((await listSourceScores(pool,u))[0]?.payload.performance.scored).toBe(0);
      await controlSource(pool, u, result.sourceProfileId, "paused");
      expect(
        await finishMemoryOutbox(pool, claim!, {
          status: "verified",
          hash: "a".repeat(64),
          blobId: "fixture",
        }),
      ).toBe(false);
      expect(await claimMemoryOutbox(pool)).toBeNull();
      await expect(
        controlSource(pool, other, result.sourceProfileId, "active"),
      ).rejects.toThrow("NOT_FOUND");
    });
  },
);
