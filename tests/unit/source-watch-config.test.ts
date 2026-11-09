import { expect, it, vi } from "vitest";
const read = vi.hoisted(() => vi.fn());
vi.mock("../../packages/integrations/src/changedetection-adapter", () => ({
  readChangedetectionSnapshot: read,
}));
import { sourceWatchConfig } from "../../packages/integrations/src/source-watch-config";
it("defaults off and does not configure service without credentials", () => {
  expect(sourceWatchConfig({})).toEqual({ enabled: false, publisherHosts: [] });
});
it("binds service reads to stored identity and selector and keeps credentials server side", async () => {
  const config = sourceWatchConfig({
    SOURCE_WATCH_ENABLED: "true",
    SOURCE_WATCH_PUBLISHER_HOSTS: "official.test",
    SOURCE_WATCH_SERVICE_URL: "https://watch.test",
    SOURCE_WATCH_SERVICE_KEY: "private-key",
    SOURCE_WATCH_SERVICE_HOSTS: "watch.test",
  });
  read.mockResolvedValue({ snapshot: { value: "changed" } });
  expect(
    await config.readServiceSnapshot?.("registered", {
      event_id: "event",
      origin_id: "official",
      url: "https://official.test",
      content_class: "html",
      selector: ".lineup",
    }),
  ).toEqual({ value: "changed" });
  expect(read).toHaveBeenCalledWith(
    expect.objectContaining({
      apiKey: "private-key",
      serviceWatchId: "registered",
      binding: {
        eventId: "event",
        originId: "official",
        url: "https://official.test",
        contentClass: "html",
        selector: ".lineup",
      },
    }),
  );
  expect(JSON.stringify(config)).not.toContain("private-key");
});
