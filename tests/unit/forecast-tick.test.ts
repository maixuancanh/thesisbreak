import { expect, it, vi } from "vitest";
import { authorizeForecastTick } from "../../packages/integrations/src/forecast-tick";
import { triggerForecastTick } from "../../packages/integrations/src/cloudflare-forecast-cron";
it("fails closed for missing, weak or incorrect worker credentials", () => {
  expect(authorizeForecastTick(null, undefined)).toBe(false);
  expect(authorizeForecastTick("Bearer x", "x")).toBe(false);
  expect(
    authorizeForecastTick(`Bearer ${"b".repeat(64)}`, "a".repeat(64)),
  ).toBe(false);
  expect(
    authorizeForecastTick(`Bearer ${"a".repeat(64)}`, "a".repeat(64)),
  ).toBe(true);
});
it("cron calls only the fixed protected endpoint and rejects HTTP failures", async () => {
  const read = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("unavailable", { status: 503 }));
  await expect(
    triggerForecastTick({ FORECAST_CRON_SECRET: "a".repeat(64) }, read),
  ).rejects.toThrow("FORECAST_HTTP_503");
  expect(read.mock.calls[0]?.[0]).toBe(
    "https://thesisbreak.vercel.app/api/internal/forecast-tick",
  );
  expect(read.mock.calls[0]?.[1]?.redirect).toBe("manual");
});
it("refuses redirects without forwarding the bearer to another destination", async () => {
  const read = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { location: "https://example.com" },
    }),
  );
  await expect(
    triggerForecastTick({ FORECAST_CRON_SECRET: "a".repeat(64) }, read),
  ).rejects.toThrow("FORECAST_HTTP_302");
  expect(read).toHaveBeenCalledTimes(1);
});
it("maintenance cron uses a separate fixed authenticated route", async () => {
  const read = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
  await triggerForecastTick(
    { FORECAST_CRON_SECRET: "a".repeat(64) },
    read,
    true,
  );
  expect(read.mock.calls[0]?.[0]).toBe(
    "https://thesisbreak.vercel.app/api/internal/forecast-maintenance",
  );
});
