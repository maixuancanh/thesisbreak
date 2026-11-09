/** Read-only check. No wallet signatures or remote memory writes. */
import "dotenv/config";
import { TatumSuiGrpcProof } from "../packages/integrations/src/tatum/sui-grpc-proof";
import { SuiProofError } from "../packages/integrations/src/tatum/sui-proof";
try {
  const proof = await new TatumSuiGrpcProof({
    apiKey: process.env.TATUM_API_KEY ?? "",
    accountId: process.env.MEMWAL_ACCOUNT_ID ?? "",
    owner: process.env.MEMWAL_OWNER_ADDRESS ?? "",
  }).verify();
  console.log(
    JSON.stringify({
      check: "tatum.sui.account",
      status: "observed",
      ...proof,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      check: "tatum.sui.account",
      status: "failed",
      code:
        error instanceof SuiProofError ? error.code : "PROVIDER_UNAVAILABLE",
    }),
  );
  process.exitCode = 1;
}
