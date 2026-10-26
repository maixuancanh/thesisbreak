import { describe, it, expect } from "vitest";
import { agentMessageSchema } from "../../packages/db/src/agent-runs";
import { messageIdentity } from "../../apps/web/lib/agent-client";
const message = {
  platform: "kalshi",
  nativeId: "KXTEST-26-T0.1",
  provider: "public",
  message: "Explain",
  requestId: "dbf74027-3a1b-4649-b9cd-25fdc02f5a02",
};
describe("agent client and server boundary", () => {
  it("accepts exact decimal native identity but rejects supplied user/source/history", () => {
    expect(agentMessageSchema.parse(message).nativeId).toBe(message.nativeId);
    for (const extra of [
      { userId: "other" },
      { history: [] },
      { context: { rules: "fake" } },
      { sourceUrl: "https://evil.test" },
    ])
      expect(
        agentMessageSchema.safeParse({ ...message, ...extra }).success,
      ).toBe(false);
  });
  it("keeps request identity for identical retry and rotates on a changed message", () => {
    const previous = { text: "hello", requestId: "old" };
    expect(messageIdentity(previous, "hello", () => "new")).toBe(previous);
    expect(messageIdentity(previous, "changed", () => "new").requestId).toBe(
      "new",
    );
  });
});
