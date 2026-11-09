import { createHmac, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
const accept = vi.hoisted(() => vi.fn());
vi.mock("../../packages/integrations/src/source-watch", () => ({
  acceptSourceWatchWebhook: accept,
}));
import { POST } from "../../apps/web/app/api/internal/source-watch-notification/route";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it("rejects unsigned notifications without dispatch", async () => {
  expect(
    (
      await POST(
        new Request("https://app.test/api/internal/source-watch-notification", {
          method: "POST",
        }),
      )
    ).status,
  ).toBe(401);
  expect(accept).not.toHaveBeenCalled();
});
it("rejects tampered or oversized signed notification before database access", async () => {
  vi.stubEnv("SOURCE_WATCH_WEBHOOK_SECRET", "s".repeat(32));
  const body = JSON.stringify({
    schemaVersion: 1,
    serviceWatchId: "watch",
    timestamp: new Date().toISOString(),
    nonce: randomUUID(),
  });
  const signature = createHmac("sha256", "s".repeat(32))
    .update(body)
    .digest("hex");
  const request = (data: string) =>
    new Request("https://app.test/api/internal/source-watch-notification", {
      method: "POST",
      headers: { "x-source-signature": signature },
      body: data,
    });
  expect((await POST(request(body + " "))).status).toBe(401);
  expect((await POST(request("x".repeat(4097)))).status).toBe(413);
  expect(accept).not.toHaveBeenCalled();
});
