import { afterEach, expect, it, vi } from "vitest";
import clock from "../../packages/integrations/src/cloudflare-forecast-cron";
afterEach(() => vi.unstubAllGlobals());
const env = {
  FORECAST_CRON_SECRET: "f".repeat(64),
  FORECAST_CHALLENGER_ENABLED: "true",
  FORECAST_CHALLENGER_MODE: "shadow",
  SOURCE_WATCH_ENABLED: "true",
  SOURCE_WATCH_CRON_SECRET: "s".repeat(64),
};
it("shares one auxiliary clock while dispatching three isolated endpoints", async () => {
  const read = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}"));
  vi.stubGlobal("fetch", read);
  await clock.scheduled({ cron: "*/5 * * * *" }, env);
  expect(read.mock.calls.map(([url]) => String(url).split("/").at(-1))).toEqual([
    "forecast-maintenance", "forecast-challenger", "source-watch-tick",
  ]);
});
it("a maintenance failure never prevents the other dispatches", async () => {
  const read = vi.fn<typeof fetch>().mockImplementation(async (url) =>
    new Response(null, {status: String(url).endsWith("maintenance") ? 503 : 200}));
  vi.stubGlobal("fetch", read);
  await expect(clock.scheduled({ cron: "*/5 * * * *" }, env)).rejects.toThrow("AUXILIARY_WORKERS_FAILED_1");
  expect(read).toHaveBeenCalledTimes(3);
});
it("minute capture never dispatches auxiliary work", async () => {
  const read = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}"));
  vi.stubGlobal("fetch", read);
  await clock.scheduled({ cron: "* * * * *" }, env);
  expect(read).toHaveBeenCalledTimes(1);
  expect(String(read.mock.calls[0]?.[0])).toMatch(/forecast-tick$/);
});
