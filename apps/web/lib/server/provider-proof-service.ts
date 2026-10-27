import "server-only";
import { AuthError, requireUser } from "./auth";
import { SuiProofError } from "../../../../packages/integrations/src/tatum/sui-proof";
import {
  TatumSuiGrpcProof,
  type GrpcAccountProof,
} from "../../../../packages/integrations/src/tatum/sui-grpc-proof";
export type ProviderProofStatus = {
  status: "verified" | "blocked" | "unavailable";
  code: string;
  latestProof: GrpcAccountProof | null;
};
let cache:
  { identity: string; at: number; value: ProviderProofStatus } | undefined;
let pending:
  { identity: string; promise: Promise<ProviderProofStatus> } | undefined;
async function status(): Promise<ProviderProofStatus> {
  const config = {
    apiKey: process.env.TATUM_API_KEY ?? "",
    accountId: process.env.MEMWAL_ACCOUNT_ID ?? "",
    owner: process.env.MEMWAL_OWNER_ADDRESS ?? "",
  };
  // In-memory identity only; never returned or logged. Config rotation invalidates proof.
  const identity = JSON.stringify(config);
  if (cache?.identity === identity && Date.now() - cache.at < 60_000)
    return cache.value;
  if (pending?.identity === identity) return pending.promise;
  const promise = (async (): Promise<ProviderProofStatus> => {
    let value: ProviderProofStatus;
    try {
      value = {
        status: "verified",
        code: "ACCOUNT_OBSERVED",
        latestProof: await new TatumSuiGrpcProof(config).verify(),
      };
    } catch (error) {
      const code =
        error instanceof SuiProofError ? error.code : "PROVIDER_UNAVAILABLE";
      value = {
        status: ["TATUM_NOT_CONFIGURED", "INVALID_PROOF_CONFIG"].includes(code)
          ? "blocked"
          : "unavailable",
        code,
        latestProof: null,
      };
    }
    cache = { identity, at: Date.now(), value };
    return value;
  })();
  pending = { identity, promise };
  try {
    return await promise;
  } finally {
    if (pending?.promise === promise) pending = undefined;
  }
}
export async function providerProofOperation() {
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  try {
    await requireUser();
    return json(await status());
  } catch (error) {
    return error instanceof AuthError
      ? json({ error: error.message }, error.status)
      : json({ error: "PROOF_UNAVAILABLE" }, 503);
  }
}
