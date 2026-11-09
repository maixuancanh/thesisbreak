import { expect, it } from "vitest";
import {
  validateGrpcAccountProof,
  SUI_MAINNET_GENESIS,
} from "../../packages/integrations/src/tatum/sui-grpc-proof";
import { MEMWAL_ACCOUNT_TYPE } from "../../packages/integrations/src/tatum/sui-proof";
const accountId = `0x${"1".repeat(64)}`,
  owner = `0x${"2".repeat(64)}`;
const object = {
  objectId: accountId,
  version: "42",
  type: MEMWAL_ACCOUNT_TYPE,
  owner: { $kind: "Shared" },
  json: { id: accountId, owner, active: true, admin_quarantined: false },
};
it("verifies account fields on the pinned genesis without claiming forecast timing or delegate authorization", () => {
  expect(
    validateGrpcAccountProof(
      { chainId: SUI_MAINNET_GENESIS, chain: "mainnet", checkpointHeight: 1n },
      object,
      { accountId, owner },
    ),
  ).toMatchObject({
    source: "tatum_sui_grpc",
    chainVerified: true,
    ownerFieldVerified: true,
    authorizationVerified: false,
    forecastTimingVerified: false,
  });
});
it("rejects foreign network, wrong owner, inactive or wrong account type", () => {
  const s = {
    chainId: SUI_MAINNET_GENESIS,
    chain: "mainnet",
    checkpointHeight: 1n,
  };
  expect(() =>
    validateGrpcAccountProof({ ...s, chainId: "foreign" }, object, {
      accountId,
      owner,
    }),
  ).toThrow("CHAIN_MISMATCH");
  for (const bad of [
    { ...object, type: "other" },
    { ...object, json: { ...object.json, owner: accountId } },
    { ...object, json: { ...object.json, active: false } },
    { ...object, json: { ...object.json, admin_quarantined: true } },
  ])
    expect(() =>
      validateGrpcAccountProof(s, bad, { accountId, owner }),
    ).toThrow("OBJECT_MISMATCH");
});
it("can observe an account without pretending to verify an unconfigured owner", () => {
  expect(
    validateGrpcAccountProof(
      { chainId: SUI_MAINNET_GENESIS, chain: "mainnet", checkpointHeight: 1n },
      object,
      { accountId, owner: "" },
    ),
  ).toMatchObject({
    objectVerified: true,
    ownerFieldVerified: false,
    authorizationVerified: false,
  });
});
