import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { recallNbaForecastMemories } from "../../packages/db/src/forecast-ledger";

describe("targeted current forecast readback", () => {
  const id = "98f5ec4a-5a21-40d2-9aef-3b952ef3244b";
  const now = new Date("2026-11-05T12:00:00Z");
  const row = {
    id,
    namespace: "live",
    captured_at: "2026-11-01T12:00:00Z",
    payload: { probability: 0.6 },
    result: { status: "final", revision: 1 },
    version: 2,
    hash: "b".repeat(64),
    blob_id: "current-final",
  };
  const expected = {
    userId: "owner",
    forecastId: id,
    namespace: "live",
    capturedAt: new Date(row.captured_at).toISOString(),
    forecast: row.payload,
    result: row.result,
  };
  const remote =
    (overrides = {}) =>
    async () => ({
      sources: [
        {
          blobId: row.blob_id,
          record: {
            logicalId: `nba:live:${id}`,
            type: "nba.forecast",
            version: 2,
            hash: row.hash,
            payload: expected,
            ...overrides,
          },
        },
      ],
    });
  it("narrows the authority query and accepts only the exact current final", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ memory_consent: true }] });
    const result = await recallNbaForecastMemories(
      { query } as unknown as Pool,
      "owner",
      remote(),
      now,
      { forecastIds: [id] },
    );
    expect(result).toHaveLength(1);
    expect(query.mock.calls[0]?.[1]).toEqual(["owner", now, [id]]);
    expect(query.mock.calls[0]?.[0]).toContain("f.id=ANY($3::text[])");
  });
  it.each([
    { version: 1 },
    { hash: "c".repeat(64) },
    { payload: { ...expected, userId: "other" } },
  ])("rejects mismatched remote authority %#", async (mismatch) => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    expect(
      await recallNbaForecastMemories(
        { query } as unknown as Pool,
        "owner",
        remote(mismatch),
        now,
        { forecastIds: [id] },
      ),
    ).toEqual([]);
  });
  it("still fences revocation during targeted recall", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ memory_consent: false }] });
    expect(
      await recallNbaForecastMemories(
        { query } as unknown as Pool,
        "owner",
        remote(),
        now,
        { forecastIds: [id] },
      ),
    ).toEqual([]);
  });
  it("rejects empty and over-budget selection before reading", async () => {
    const query = vi.fn();
    for (const ids of [[], Array(5).fill(id)])
      await expect(
        recallNbaForecastMemories(
          { query } as unknown as Pool,
          "owner",
          remote(),
          now,
          { forecastIds: ids },
        ),
      ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
