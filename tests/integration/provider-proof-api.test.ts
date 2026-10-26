import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ authenticated: false }));
vi.mock("../../apps/web/node_modules/server-only", () => ({}));
vi.mock("../../apps/web/lib/server/auth", async () => {
  const policy = await import("../../apps/web/lib/server/auth-policy");
  return { ...policy, requireUser: async () => { if (!state.authenticated) throw new policy.AuthError(401, "UNAUTHENTICATED"); return { id: "owner" }; } };
});
import { providerProofOperation } from "../../apps/web/lib/server/provider-proof-service";
describe("authenticated provider proof diagnostics", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); state.authenticated = false; });
  it("requires authentication before exposing configuration status", async () => {
    expect((await providerProofOperation()).status).toBe(401);
  });
  it("never returns transport secrets or endpoints", async () => {
    state.authenticated = true;
    vi.stubEnv("TATUM_API_KEY", "secret-diagnostic-key");
    vi.stubEnv("TATUM_SUI_RPC_URL", "https://sui-mainnet.gateway.tatum.io");
    vi.stubEnv("MEMWAL_ACCOUNT_ID", `0x${"3".repeat(64)}`);
    vi.stubEnv("MEMWAL_OWNER_ADDRESS", `0x${"4".repeat(64)}`);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret-diagnostic-key https://sui-mainnet.gateway.tatum.io")));
    const response = await providerProofOperation();
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: "unavailable", code: "PROVIDER_UNAVAILABLE", latestProof: null });
    expect(body).not.toContain("secret-diagnostic-key");
    expect(body).not.toContain("gateway.tatum.io");
  });
  it("reports a blocked safe proof when Tatum key is missing", async () => {
    state.authenticated = true;
    vi.stubEnv("TATUM_API_KEY", "");
    vi.stubEnv("TATUM_SUI_RPC_URL", "https://private.example?key=secret");
    const response = await providerProofOperation();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "blocked", code: "TATUM_NOT_CONFIGURED", latestProof: null });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

