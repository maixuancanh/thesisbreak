import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  captureNbaForecast,
  recallNbaForecastMemories,
  readNbaForecastInventory,
  listNbaForecastLedger,
  recordNbaOfficialResult,
  syncNbaForecastMemory,
} from "../../packages/db/src/forecast-ledger";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("immutable forecast lifecycle", () => {
  const pool = new Pool({ connectionString: url }),
    owner = randomUUID(),
    other = randomUUID();
  beforeAll(async () => {
    for (const id of [owner, other])
      await pool.query("INSERT INTO users(id,provider_subject) VALUES($1,$1)", [
        id,
      ]);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id=ANY($1)", [[owner, other]]);
    await pool.end();
  });
  it("recalls only exact current live readbacks", async () => {
    const now = Date.now(),
      captured = new Date(now - 1000).toISOString();
    const input = {
      namespace: "live",
      eventId: randomUUID(),
      league: "NBA" as const,
      horizon: "T60m" as const,
      methodVersion: "recall-v1",
      modelVersion: "elo",
      modelConfig: {},
      scheduledAt: new Date(now + 3600000).toISOString(),
      homeTeam: "BOS",
      awayTeam: "BKN",
      probability: 0.6,
      baselineProbability: null,
      abstentionReason: null,
      evidence: [
        {
          url: "https://www.nba.com/game",
          publishedAt: captured,
          retrievedAt: captured,
        },
      ],
      memoryConsent: true,
    };
    const saved = await captureNbaForecast(pool, owner, input);
    let stored: unknown;
    await syncNbaForecastMemory(
      pool,
      {
        remember: async (r) => {
          stored = r;
          return { status: "verified", blobId: "exact", hash: "b".repeat(64) };
        },
      },
      owner,
      saved.id,
    );
    const record = stored as {
      logicalId: string;
      type: string;
      version: number;
      payload: unknown;
    };
    const remote = async () => ({
      sources: [
        { blobId: "exact", record: { ...record, hash: "b".repeat(64) } },
      ],
    });
    expect(await recallNbaForecastMemories(pool, owner, remote)).toHaveLength(
      1,
    );
    expect(await recallNbaForecastMemories(pool, other, remote)).toEqual([]);
    expect((await readNbaForecastInventory(pool, owner)).records).toHaveLength(
      1,
    );
    expect((await readNbaForecastInventory(pool, other)).records).toEqual([]);
    expect(
      await recallNbaForecastMemories(pool, owner, async () => ({
        sources: [
          { blobId: "wrong", record: { ...record, hash: "b".repeat(64) } },
        ],
      })),
    ).toEqual([]);
    // Revocation during a remote request must fence its response too.
    expect(
      await recallNbaForecastMemories(pool, owner, async () => {
        await pool.query(
          "INSERT INTO nba_forecast_subscriptions(user_id,enabled,memory_consent) VALUES($1,false,false) ON CONFLICT(user_id) DO UPDATE SET memory_consent=false",
          [owner],
        );
        return remote();
      }),
    ).toEqual([]);
    await pool.query(
      "DELETE FROM nba_forecast_subscriptions WHERE user_id=$1",
      [owner],
    );
  });
  it("isolates replay, grades corrections and writes each result version only with consent", async () => {
    const input = {
      namespace: "replay:acceptance",
      eventId: randomUUID(),
      league: "NBA" as const,
      horizon: "T60m" as const,
      methodVersion: "elo-v1",
      modelVersion: "elo",
      modelConfig: {},
      scheduledAt: "2026-10-20T12:00:00Z",
      capturedAt: "2026-10-20T11:00:00Z",
      homeTeam: "BOS",
      awayTeam: "BKN",
      probability: 0.6,
      baselineProbability: 0.5,
      abstentionReason: null,
      evidence: [
        {
          url: "https://www.nba.com/game",
          publishedAt: "2026-10-20T10:00:00Z",
          retrievedAt: "2026-10-20T10:01:00Z",
        },
      ],
      memoryConsent: true,
    };
    const saved = await captureNbaForecast(pool, owner, input);
    expect(await captureNbaForecast(pool, owner, input)).toEqual(saved);
    await expect(
      captureNbaForecast(pool, owner, { ...input, probability: 0.9 }),
    ).rejects.toThrow("IMMUTABLE_FORECAST_CONFLICT");
    await expect(
      captureNbaForecast(pool, owner, { ...input, namespace: "live" }),
    ).rejects.toThrow("LIVE_BACKDATE_FORBIDDEN");
    expect(await listNbaForecastLedger(pool, other, input.namespace)).toEqual(
      [],
    );
    expect(
      (await listNbaForecastLedger(pool, owner, "live")).some(
        (r) => r.forecast.eventId === input.eventId,
      ),
    ).toBe(false);
    const versions: number[] = [];
    const adapter = {
      remember: async (r: { version: number }) => {
        versions.push(r.version);
        return {
          status: "verified",
          blobId: `fixture-${r.version}`,
          hash: "a".repeat(64),
        };
      },
    };
    await syncNbaForecastMemory(pool, adapter, owner, saved.id);
    const result = {
      namespace: input.namespace,
      eventId: input.eventId,
      scheduledAt: input.scheduledAt,
      revision: 1,
      resolvedAt: "2026-10-20T15:00:00Z",
      status: "final" as const,
      winner: "BOS",
      verifiedOfficial: true as const,
      sourceUrl: "https://www.nba.com/game",
      retrievedAt: "2026-10-20T15:01:00Z",
    };
    await recordNbaOfficialResult(pool, owner, result);
    expect(
      (await listNbaForecastLedger(pool, owner, input.namespace))[0]?.grade
        .brier,
    ).toBeCloseTo(0.16);
    await syncNbaForecastMemory(pool, adapter, owner, saved.id);
    await recordNbaOfficialResult(pool, owner, {
      ...result,
      revision: 2,
      winner: "BKN",
    });
    await syncNbaForecastMemory(pool, adapter, owner, saved.id);
    expect(versions).toEqual([1, 2, 3]);
    expect(
      (await listNbaForecastLedger(pool, owner, input.namespace))[0]?.grade
        .brier,
    ).toBeCloseTo(0.36);
    const off = await captureNbaForecast(pool, owner, {
      ...input,
      eventId: randomUUID(),
      memoryConsent: false,
    });
    expect(
      (await syncNbaForecastMemory(pool, adapter, owner, off.id)).status,
    ).toBe("consent_required");
    expect(versions).toHaveLength(3);
  });
});
