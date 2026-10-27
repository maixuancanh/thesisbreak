import { SuiGrpcClient } from "@mysten/sui/grpc";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { ChannelCredentials } from "@grpc/grpc-js";
import { z } from "zod";
import { MEMWAL_ACCOUNT_TYPE, SuiProofError } from "./sui-proof";

export const SUI_MAINNET_GENESIS =
  "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S";
const address = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const objectSchema = z.object({
  objectId: address,
  version: z.string().regex(/^[1-9][0-9]*$/),
  type: z.literal(MEMWAL_ACCOUNT_TYPE),
  owner: z.object({ $kind: z.literal("Shared") }),
  json: z.object({
    id: address,
    owner: address,
    active: z.literal(true),
    admin_quarantined: z.literal(false),
  }),
});
export function validateGrpcAccountProof(
  service: { chainId?: string; chain?: string; checkpointHeight?: bigint },
  object: unknown,
  expected: { accountId: string; owner: string },
) {
  if (
    service.chainId !== SUI_MAINNET_GENESIS ||
    service.chain !== "mainnet" ||
    !service.checkpointHeight ||
    service.checkpointHeight < 1n
  )
    throw new SuiProofError("CHAIN_MISMATCH");
  const parsed = objectSchema.safeParse(object);
  if (
    !parsed.success ||
    parsed.data.objectId.toLowerCase() !== expected.accountId.toLowerCase() ||
    parsed.data.json.id.toLowerCase() !== expected.accountId.toLowerCase() ||
    (expected.owner !== "" &&
      parsed.data.json.owner.toLowerCase() !== expected.owner.toLowerCase())
  )
    throw new SuiProofError("OBJECT_MISMATCH");
  return {
    source: "tatum_sui_grpc" as const,
    chainId: SUI_MAINNET_GENESIS,
    chainVerified: true as const,
    objectVerified: true as const,
    ownerFieldVerified: expected.owner !== "",
    authorizationVerified: false as const,
    forecastTimingVerified: false as const,
    checkedAt: new Date().toISOString(),
    objectVersion: parsed.data.version,
    checkpointHeight: service.checkpointHeight.toString(),
  };
}
export type GrpcAccountProof = ReturnType<typeof validateGrpcAccountProof>;
export class TatumSuiGrpcProof {
  constructor(
    private readonly config: {
      apiKey: string;
      accountId: string;
      owner: string;
    },
  ) {
    if (typeof window !== "undefined") throw new SuiProofError("SERVER_ONLY");
    if (!config.apiKey?.trim()) throw new SuiProofError("TATUM_NOT_CONFIGURED");
    if (
      !address.safeParse(config.accountId).success ||
      (config.owner !== "" && !address.safeParse(config.owner).success)
    )
      throw new SuiProofError("INVALID_PROOF_CONFIG");
  }
  async verify(): Promise<GrpcAccountProof> {
    const transport = new GrpcTransport({
      host: "sui-mainnet-grpc.gateway.tatum.io:443",
      channelCredentials: ChannelCredentials.createSsl(),
      channelOptions: { "grpc.max_receive_message_length": 262144 },
      meta: { "x-api-key": this.config.apiKey },
    });
    try {
      const client = new SuiGrpcClient({ network: "mainnet", transport });
      const signal = AbortSignal.timeout(15_000);
      const service = await client.ledgerService.getServiceInfo(
        {},
        { abort: signal },
      ).response;
      // Fail before reading account data on an unexpected network.
      if (service.chainId !== SUI_MAINNET_GENESIS)
        throw new SuiProofError("CHAIN_MISMATCH");
      const { object } = await client.getObject({
        objectId: this.config.accountId,
        include: { json: true },
        signal,
      });
      return validateGrpcAccountProof(service, object, this.config);
    } catch (error) {
      if (error instanceof SuiProofError) throw error;
      // gRPC messages may contain metadata: return only a bounded public code.
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      throw new SuiProofError(
        code === "UNAUTHENTICATED" || code === "PERMISSION_DENIED"
          ? "PROVIDER_ACCESS_DENIED"
          : code === "RESOURCE_EXHAUSTED"
            ? "PROVIDER_RATE_LIMITED"
            : "PROVIDER_UNAVAILABLE",
      );
    } finally {
      transport.close();
    }
  }
}
