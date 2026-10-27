import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
vi.mock("../../apps/web/node_modules/server-only", () => ({}));
import {
  createTatumReaders,
  tatumOperationSchema,
} from "../../apps/web/lib/server/tatum-service";
describe("Tatum research enablement", () => {
  it("requires explicit enablement even with an API key", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const readers = createTatumReaders(
      {} as Pool,
      { platform: "kalshi", nativeId: "TEST" },
      { TATUM_API_KEY: "test-key" },
    );
    await expect(readers.readTatumQuote()).rejects.toThrow(
      "TATUM_RESEARCH_DISABLED",
    );
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
  });
  it("does not send a request before a successful durable reservation", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("database unavailable"));
    const fetcher = vi.spyOn(globalThis, "fetch");
    const readers = createTatumReaders(
      { query } as unknown as Pool,
      { platform: "kalshi", nativeId: "TEST" },
      {
        TATUM_API_KEY: "test-key",
        TATUM_RESEARCH_ENABLED: "true",
        TATUM_DAILY_CREDIT_LIMIT: "1000",
      },
    );
    await expect(readers.readTatumQuote()).rejects.toThrow(
      "database unavailable",
    );
    expect(query).toHaveBeenCalledTimes(2);
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
  });
});

it("validates bounded history and capability-specific discovery parameters", () => {
  expect(
    tatumOperationSchema.parse({
      operation: "history",
      platform: "kalshi",
      id: "TEST",
      interval: "1h",
      start: "2026-10-26T00:00:00Z",
      end: "2026-10-27T00:00:00Z",
    }).operation,
  ).toBe("history");
  expect(
    tatumOperationSchema.safeParse({
      operation: "events",
      platform: "kalshi",
      search: "team",
    }).success,
  ).toBe(false);
  expect(
    tatumOperationSchema.safeParse({
      operation: "events",
      platform: "polymarket",
      limit: "1000",
    }).success,
  ).toBe(false);
  expect(
    tatumOperationSchema.safeParse({
      operation: "search",
      platform: "polymarket",
      q: "team",
      url: "https://evil.example",
    }).success,
  ).toBe(false);
  expect(
    tatumOperationSchema.parse({
      operation: "events",
      platform: "polymarket",
      limit: "10",
      includeMarkets: "false",
    }).query,
  ).toMatchObject({ limit: 10, includeMarkets: false });
});
