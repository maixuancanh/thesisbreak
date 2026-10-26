import { describe, it, expect, vi } from "vitest";
vi.mock("../../apps/web/node_modules/server-only", () => ({}));
vi.mock("../../apps/web/lib/server/auth", async () => {
  const p = await import("../../apps/web/lib/server/auth-policy");
  return {
    ...p,
    requireUser: async () => {
      throw new p.AuthError(401, "UNAUTHENTICATED");
    },
  };
});
import {
  runStatus,
  runStream,
  runCancel,
  registerRunAbort,
  unregisterRunAbort,
  abortOwnedRun,
} from "../../apps/web/lib/server/run-control-service";
describe("run control boundaries", () => {
  it("authenticates before parsing run identifiers or cancel bodies", async () => {
    for (const f of [runStatus, runStream, runCancel])
      expect(
        (await f(new Request("https://example.test"), "invalid")).status,
      ).toBe(401);
  });
  it("only aborts matching owned active controllers", () => {
    const c = new AbortController();
    registerRunAbort("r", "u", c);
    abortOwnedRun("r", "foreign");
    expect(c.signal.aborted).toBe(false);
    abortOwnedRun("r", "u");
    expect(c.signal.aborted).toBe(true);
    unregisterRunAbort("r", c);
  });
});
