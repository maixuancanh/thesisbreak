import { z } from "zod";

export const SUI_MAINNET_CHAIN_ID = "35834a8a";
// Official relayer /config inspected 2026-10-25; SDK 0.1.9 uses this config,
// and account.ts identifies the ::account::MemWalAccount struct.
export const MEMWAL_ACCOUNT_TYPE =
  "0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5::account::MemWalAccount";
const address = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const normalized = (value: string) => value.toLowerCase();
export class SuiProofError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export type SuiAccountProof = {
  source: "tatum_sui_jsonrpc";
  chainId: typeof SUI_MAINNET_CHAIN_ID;
  chainVerified: true;
  objectVerified: true;
  ownerFieldVerified: true;
  authorizationVerified: false;
  checkedAt: string;
  objectVersion: string;
};
export class TatumSuiProof {
  constructor(
    private readonly config: {
      apiKey: string;
      rpcUrl: string;
      accountId: string;
      owner: string;
    },
    private readonly transport: typeof fetch = fetch,
  ) {
    if (typeof window !== "undefined") throw new SuiProofError("SERVER_ONLY");
    if (!config.apiKey?.trim()) throw new SuiProofError("TATUM_NOT_CONFIGURED");
    try {
      const url = new URL(config.rpcUrl);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "sui-mainnet.gateway.tatum.io" ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash ||
        url.pathname !== "/" ||
        !address.safeParse(config.accountId).success ||
        !address.safeParse(config.owner).success
      )
        throw new Error();
    } catch {
      throw new SuiProofError("INVALID_PROOF_CONFIG");
    }
  }
  private async rpc(
    method: string,
    params: unknown[],
    id: number,
  ): Promise<unknown> {
    try {
      const response = await this.transport(this.config.rpcUrl, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.apiKey,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      if (!response.ok)
        throw new SuiProofError(
          response.status === 401 || response.status === 403
            ? "PROVIDER_ACCESS_DENIED"
            : response.status === 429
              ? "PROVIDER_RATE_LIMITED"
              : "PROVIDER_UNAVAILABLE",
        );
      const reader = response.body?.getReader();
      if (!reader) throw new SuiProofError("INVALID_PROVIDER_RESPONSE");
      let bytes = 0;
      let text = "";
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 65_536) {
            await reader.cancel();
            throw new SuiProofError("INVALID_PROVIDER_RESPONSE");
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new SuiProofError("INVALID_PROVIDER_RESPONSE");
      }
      const parsed = z
        .object({
          jsonrpc: z.literal("2.0"),
          id: z.literal(id),
          result: z.unknown(),
          error: z.unknown().optional(),
        })
        .safeParse(payload);
      if (
        !parsed.success ||
        parsed.data.error !== undefined ||
        !Object.hasOwn(parsed.data, "result")
      )
        throw new SuiProofError("INVALID_PROVIDER_RESPONSE");
      return parsed.data.result;
    } catch (error) {
      if (error instanceof SuiProofError) throw error;
      throw new SuiProofError("PROVIDER_UNAVAILABLE");
    }
  }
  async verify(): Promise<SuiAccountProof> {
    if (
      (await this.rpc("sui_getChainIdentifier", [], 1)) !== SUI_MAINNET_CHAIN_ID
    )
      throw new SuiProofError("CHAIN_MISMATCH");
    const result = await this.rpc(
      "sui_getObject",
      [
        this.config.accountId,
        { showType: true, showOwner: true, showContent: true },
      ],
      2,
    );
    const parsed = z
      .object({
        data: z.object({
          objectId: address,
          version: z.string().regex(/^[1-9][0-9]*$/),
          type: z.literal(MEMWAL_ACCOUNT_TYPE),
          owner: z
            .object({
              Shared: z.object({
                initial_shared_version: z.string().regex(/^[1-9][0-9]*$/),
              }),
            })
            .strict(),
          content: z.object({
            dataType: z.literal("moveObject"),
            type: z.literal(MEMWAL_ACCOUNT_TYPE),
            fields: z.object({ id: z.object({ id: address }), owner: address }),
          }),
        }),
        error: z.unknown().optional(),
      })
      .safeParse(result);
    if (
      !parsed.success ||
      parsed.data.error !== undefined ||
      normalized(parsed.data.data.objectId) !==
        normalized(this.config.accountId) ||
      normalized(parsed.data.data.content.fields.id.id) !==
        normalized(this.config.accountId) ||
      normalized(parsed.data.data.content.fields.owner) !==
        normalized(this.config.owner)
    )
      throw new SuiProofError("OBJECT_MISMATCH");
    return {
      source: "tatum_sui_jsonrpc",
      chainId: SUI_MAINNET_CHAIN_ID,
      chainVerified: true,
      objectVerified: true,
      ownerFieldVerified: true,
      authorizationVerified: false,
      checkedAt: new Date().toISOString(),
      objectVersion: parsed.data.data.version,
    };
  }
}
