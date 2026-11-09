import { afterEach, describe, expect, it, vi } from "vitest";
import cron, {
  triggerSourceWatch,
} from "../../packages/integrations/src/cloudflare-forecast-cron";
afterEach(() => vi.unstubAllGlobals());
const env = {
  FORECAST_CRON_SECRET: "f".repeat(64),
  SOURCE_WATCH_CRON_SECRET: "s".repeat(64),
  SOURCE_WATCH_ENABLED: "true",
};
describe("independent source-watch cron", () => {
  it("does nothing unless explicitly enabled", async () => {
    const transport = vi.fn<typeof fetch>();
    await triggerSourceWatch(
      { ...env, SOURCE_WATCH_ENABLED: undefined },
      transport,
    );
    await triggerSourceWatch(
      { ...env, SOURCE_WATCH_ENABLED: "false" },
      transport,
    );
    expect(transport).not.toHaveBeenCalled();
  });
  it("requires the separate strong source-watch secret before making a request", async () => {
    const transport = vi.fn<typeof fetch>();
    for (const SOURCE_WATCH_CRON_SECRET of [undefined, "short"])
      await expect(
        triggerSourceWatch({ ...env, SOURCE_WATCH_CRON_SECRET }, transport),
      ).rejects.toThrow("SOURCE_WATCH_CRON_UNCONFIGURED");
    expect(transport).not.toHaveBeenCalled();
  });
  it("calls only the fixed protected bounded route and uses only its own secret", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}"));
    await triggerSourceWatch(env, transport);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toBe(
      "https://thesisbreak.vercel.app/api/internal/source-watch-tick",
    );
    const init = transport.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${env.SOURCE_WATCH_CRON_SECRET}`,
    });
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it("rejects redirects and failures without forwarding the bearer elsewhere", async () => {
    for (const status of [302, 503]) {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(null, {
            status,
            headers: { location: "https://other.example" },
          }),
        );
      await expect(triggerSourceWatch(env, transport)).rejects.toThrow(
        `SOURCE_WATCH_HTTP_${status}`,
      );
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
  it("dispatches source watch independently of forecast calls", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", transport);
    await cron.scheduled({ cron: "3-59/10 * * * *" }, env);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toBe(
      "https://thesisbreak.vercel.app/api/internal/source-watch-tick",
    );
  });
});
