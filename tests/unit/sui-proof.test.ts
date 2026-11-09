import { describe, expect, it, vi } from "vitest";
import { TatumSuiProof, MEMWAL_ACCOUNT_TYPE } from "../../packages/integrations/src/tatum/sui-proof";
const accountId = `0x${"1".repeat(64)}`;
const owner = `0x${"2".repeat(64)}`;
const config = { apiKey: "private-key", rpcUrl: "https://sui-mainnet.gateway.tatum.io", accountId, owner };
const object = () => ({ data: { objectId: accountId, version: "7", digest: "digest", type: MEMWAL_ACCOUNT_TYPE, owner: { Shared: { initial_shared_version: "1" } }, content: { dataType: "moveObject", type: MEMWAL_ACCOUNT_TYPE, fields: { id: { id: accountId }, owner } } } });
function transport(chain: unknown = "35834a8a", value: unknown = object()) {
  return vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    return Response.json({ jsonrpc: "2.0", id: request.id, result: request.method === "sui_getChainIdentifier" ? chain : value });
  });
}
describe("Tatum read-only Sui proof", () => {
  it("verifies exact chain, account type and stored owner with server header", async () => {
    const fetcher = transport();
    const result = await new TatumSuiProof(config, fetcher).verify();
    expect(result).toMatchObject({ chainVerified: true, objectVerified: true, ownerFieldVerified: true, authorizationVerified: false, source: "tatum_sui_jsonrpc", chainId: "35834a8a" });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", headers: { "x-api-key": "private-key" } });
    expect(JSON.stringify(result)).not.toContain("private-key");
  });
  it.each(["testnet", "35834a8a-extra", null])("rejects wrong network %s", async (chain) => {
    const fetcher = transport(chain);
    await expect(new TatumSuiProof(config, fetcher).verify()).rejects.toThrow("CHAIN_MISMATCH");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["id", "type", "owner", "shared"])("rejects mismatched %s", async (field) => {
    const value = object();
    if (field === "id") value.data.objectId = owner;
    if (field === "type") value.data.type = `${owner}::account::MemWalAccount`;
    if (field === "owner") value.data.content.fields.owner = accountId;
    if (field === "shared") value.data.owner.Shared.initial_shared_version = "invalid";
    await expect(new TatumSuiProof(config, transport("35834a8a", value)).verify()).rejects.toThrow("OBJECT_MISMATCH");
  });
  it("blocks missing credentials and arbitrary endpoints before transport", () => {
    expect(() => new TatumSuiProof({ ...config, apiKey: "" })).toThrow("TATUM_NOT_CONFIGURED");
    for (const rpcUrl of ["http://sui-mainnet.gateway.tatum.io", "https://evil.test", "https://sui-mainnet.gateway.tatum.io?key=secret", "https://sui-mainnet.gateway.tatum.io/path"]) expect(() => new TatumSuiProof({ ...config, rpcUrl })).toThrow("INVALID_PROOF_CONFIG");
  });
  it("redacts transport errors and bounds payload size", async () => {
    await expect(new TatumSuiProof(config, vi.fn().mockRejectedValue(new Error("private-key endpoint"))).verify()).rejects.toThrow(/^PROVIDER_UNAVAILABLE$/);
    await expect(new TatumSuiProof(config, vi.fn().mockResolvedValue(new Response("x".repeat(65537)))).verify()).rejects.toThrow("INVALID_PROVIDER_RESPONSE");
  });
});
