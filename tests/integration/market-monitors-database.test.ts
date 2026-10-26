import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPick } from "../../packages/db/src/picks";
import { saveIndependentChecks } from "../../packages/db/src/independent-evidence";
import {
  createMonitor,
  claimMonitor,
  finishMonitor,
  monitorInbox,
  controlMonitor,
} from "../../packages/db/src/market-monitors";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "market observation monitoring (isolated PostgreSQL)",
  () => {
    const pool = new Pool({ connectionString: url }),
      user = randomUUID(),
      other = randomUUID(),
      nativeId = `WATCH-${randomUUID()}`;
    let pickId = "";
    const observation = {
      rules: "Official settlement",
      prices: [
        { name: "Yes", price: 0.4 },
        { name: "No", price: 0.6 },
      ],
      sourceUrl: "https://kalshi.com/test",
      fetchedAt: new Date().toISOString(),
    };
    beforeAll(async () => {
      for (const id of [user, other])
        await pool.query(
          "INSERT INTO users(id,provider_subject) VALUES($1,$1)",
          [id],
        );
      const pick = await createPick(
        pool,
        user,
        {
          platform: "kalshi",
          nativeId,
          outcome: "Yes",
          reason: "I expect LeBron James to play.",
          requestId: randomUUID(),
        },
        async () => ({
          platform: "kalshi",
          nativeId,
          eventId: null,
          question: "Fixture question",
          outcomes: observation.prices,
          rulesReference: observation.sourceUrl,
          rulesHash: "fixture",
          closeTime: null,
          fetchedAt: observation.fetchedAt,
          priceAsOf: null,
          nativeUnit: "probability",
          raw: { catalogProvider: "tatum" },
        }),
      );
      pickId = (pick as { pickId: string }).pickId;
    });
    afterAll(async () => {
      await pool.query(
        "DELETE FROM independent_source_checks WHERE native_id=$1",
        [nativeId],
      );
      await pool.query("DELETE FROM independent_evidence WHERE native_id=$1", [
        nativeId,
      ]);
      await pool.query("DELETE FROM users WHERE id=ANY($1)", [[user, other]]);
      await pool.query("DELETE FROM market_snapshots WHERE native_id=$1", [
        nativeId,
      ]);
      await pool.query("DELETE FROM markets WHERE native_id=$1", [nativeId]);
      await pool.end();
    });
    it("preserves source, idempotency, ownership, deduplication and pause fencing", async () => {
      const input = {
        pickId,
        baseVersion: 1,
        confirmed: true,
        durationHours: 24,
        independentNews: true,
        requestId: randomUUID(),
      };
      const result = await createMonitor(pool, user, input);
      expect(await createMonitor(pool, user, input)).toEqual(result);
      await expect(
        createMonitor(pool, other, { ...input, requestId: randomUUID() }),
      ).rejects.toThrow("NOT_FOUND");
      const first = await claimMonitor(pool);
      expect(first?.provider).toBe("tatum");
      expect(first?.independentNews).toBe(true);
      const news = {
        source: "nba-official",
        state: "available" as const,
        background: false,
        checkedAt: new Date().toISOString(),
        items: [
          {
            id: "fixture",
            url: "https://official.nba.com/report",
            title: "Official status",
            text: "Source status",
            publishedAt: null,
            retrievedAt: new Date().toISOString(),
            eventDate: "2026-10-26",
            teams: ["Los Angeles Lakers", "Utah Jazz"],
            player: "James, LeBron",
            status: "Questionable",
          },
        ],
      };
      await saveIndependentChecks(
        pool,
        { platform: "kalshi", nativeId },
        [news],
        first!,
      );
      expect(await claimMonitor(pool)).toBeNull();
      expect(await finishMonitor(pool, first!, observation)).toBe(true);
      expect((await monitorInbox(pool, user)).updates).toHaveLength(0);
      await pool.query(
        "UPDATE market_monitors SET next_check_at=now() WHERE id=$1",
        [result.id],
      );
      const second = await claimMonitor(pool);
      const changedNews = {
        ...news,
        checkedAt: new Date().toISOString(),
        items: news.items.map((i) => ({ ...i, status: "Out" })),
      };
      // A chat/public source refresh must not consume another watch's baseline.
      await saveIndependentChecks(pool, { platform: "kalshi", nativeId }, [
        changedNews,
      ]);
      await saveIndependentChecks(
        pool,
        { platform: "kalshi", nativeId },
        [changedNews],
        second!,
      );
      const changed = {
        ...observation,
        prices: [
          { name: "Yes", price: 0.7 },
          { name: "No", price: 0.3 },
        ],
      };
      await finishMonitor(pool, second!, changed);
      const inbox = await monitorInbox(pool, user);
      expect(inbox.updates).toHaveLength(2);
      expect(
        inbox.updates.some((u) => u.kind === "player_status_changed"),
      ).toBe(true);
      expect(inbox.updates.some((u) => u.kind === "price_changed")).toBe(true);
      expect(inbox.updates[0].evidence.reasonChanged).toBe(false);
      expect((await monitorInbox(pool, other)).updates).toEqual([]);
      for (const [index, status] of ["Questionable", "Out"].entries()) {
        await pool.query(
          "UPDATE market_monitors SET next_check_at=now() WHERE id=$1",
          [result.id],
        );
        const repeat = await claimMonitor(pool);
        const update = {
          ...news,
          checkedAt: new Date().toISOString(),
          items: news.items.map((i) => ({
            ...i,
            status,
            id: `report-${index}`,
            url: `https://official.nba.com/report-${index}`,
          })),
        };
        await saveIndependentChecks(
          pool,
          { platform: "kalshi", nativeId },
          [update],
          repeat!,
        );
        await finishMonitor(pool, repeat!, changed);
      }
      expect(
        (await monitorInbox(pool, user)).updates.filter(
          (u) => u.kind === "player_status_changed",
        ),
      ).toHaveLength(3);
      await pool.query(
        "UPDATE market_monitors SET next_check_at=now() WHERE id=$1",
        [result.id],
      );
      const third = await claimMonitor(pool);
      await controlMonitor(pool, user, result.id, "paused");
      expect(
        await saveIndependentChecks(
          pool,
          { platform: "kalshi", nativeId },
          [news],
          third!,
        ),
      ).toBe(false);
      expect(await finishMonitor(pool, third!, observation)).toBe(false);
      await createMonitor(pool, user, { ...input, requestId: randomUUID() });
      const resumed = await claimMonitor(pool);
      expect(resumed?.observation).toBeNull();
      const resolution = {
        outcome: "Yes",
        resolvedAt: new Date(Date.now() + 1000).toISOString(),
      };
      await finishMonitor(pool, resumed!, {
        ...observation,
        resolution,
        fetchedAt: new Date(Date.now() + 2000).toISOString(),
      });
      const resolved = (await monitorInbox(pool, user)).updates.find(
        (u) => u.kind === "market_resolved",
      );
      expect(resolved?.evidence.assessment).toMatchObject({
        pickVersion: 1,
        pickedOutcome: "Yes",
        result: "matched",
      });
      await pool.query(
        "UPDATE market_monitors SET next_check_at=now() WHERE id=$1",
        [result.id],
      );
      await finishMonitor(pool, (await claimMonitor(pool))!, {
        ...observation,
        resolution: { outcome: "No", resolvedAt: observation.fetchedAt },
        fetchedAt: new Date(Date.now() + 3000).toISOString(),
      });
      const corrected = (await monitorInbox(pool, user)).updates.find(
        (u) => u.kind === "resolution_corrected",
      );
      expect(corrected?.evidence.assessment.result).toBe("not_scored");
    });
  },
);
