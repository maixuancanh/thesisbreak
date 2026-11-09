import { afterEach, expect, it, vi } from "vitest";
const batch = vi.hoisted(() => vi.fn());
vi.mock("../../packages/integrations/src/source-watch", () => ({
  runSourceWatchBatch: batch,
}));
import { POST } from "../../apps/web/app/api/internal/source-watch-tick/route";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it("rejects missing or incorrect worker secret before dispatch", async () => {
  vi.stubEnv("SOURCE_WATCH_CRON_SECRET", "s".repeat(32));
  expect(
    (
      await POST(
        new Request("https://app.test/api/internal/source-watch-tick", {
          method: "POST",
        }),
      )
    ).status,
  ).toBe(401);
  expect(batch).not.toHaveBeenCalled();
});
it("keeps disabled watcher idle even for authenticated scheduler", async () => {
  vi.stubEnv("SOURCE_WATCH_CRON_SECRET", "s".repeat(32));
  vi.stubEnv("SOURCE_WATCH_ENABLED", "false");
  const r = await POST(
    new Request("https://app.test/api/internal/source-watch-tick", {
      method: "POST",
      headers: { Authorization: `Bearer ${"s".repeat(32)}` },
    }),
  );
  expect(await r.json()).toEqual({ status: "disabled" });
  expect(batch).not.toHaveBeenCalled();
});
it("rejects the forecast secret and bounds an authorized source tick to one watch", async () => {
  vi.stubEnv("SOURCE_WATCH_CRON_SECRET", "s".repeat(32));
  vi.stubEnv("FORECAST_CRON_SECRET", "f".repeat(32));
  vi.stubEnv("SOURCE_WATCH_ENABLED", "true");
  vi.stubEnv("DATABASE_URL", "postgres://test:test@127.0.0.1:1/test");
  const request = (secret: string) =>
    new Request("https://app.test/api/internal/source-watch-tick", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ limit: 10000 }),
    });
  expect((await POST(request("f".repeat(32)))).status).toBe(401);
  expect(batch).not.toHaveBeenCalled();
  batch.mockResolvedValueOnce([]);
  const result = await POST(request("s".repeat(32)));
  expect(await result.json()).toEqual({ results: [] });
  expect(batch).toHaveBeenCalledTimes(1);
  expect(batch.mock.calls[0]?.[2]).toBe(1);
});
