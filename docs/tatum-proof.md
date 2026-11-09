# Tatum Sui account observation

`ProviderProof` (`apps/web/components/provider-proof.tsx`) can be imported into the authenticated account or memory screen. Its button calls `GET /api/providers/proof`; the handler invokes `requireUser` before any configuration diagnostics or upstream access. The endpoint returns `Cache-Control: no-store` and only safe status codes and a `latestProof` observation. Raw RPC endpoints, keys, account addresses, content and upstream error messages are not returned.

Configure server-only `TATUM_API_KEY`, `TATUM_SUI_RPC_URL=https://sui-mainnet.gateway.tatum.io`, `MEMWAL_ACCOUNT_ID`, and `MEMWAL_OWNER_ADDRESS`. Account ID and owner must be full 32-byte hex Sui addresses. The owner is an explicitly configured expected address, not a browser value or authenticated Google identity. Missing Tatum credentials produce `blocked` with `latestProof: null`. This task did not locate or enable a Tatum key; live Tatum verification remains blocked. There is no fallback RPC.

The adapter reads `sui_getChainIdentifier` and requires exactly `35834a8a` before reading `sui_getObject` with type, owner and content enabled. It checks the requested and returned object IDs, the nested Move ID, exact package/module/type, Shared ownership metadata, and `content.fields.owner`. MemWal accounts are shared objects, so Sui's `owner` metadata is not the account's owner address. No transaction construction, signing or broadcast exists here.

The installed official `@mysten-incubation/memwal` 0.1.9 SDK obtains `packageId` from relayer `GET /config`; it has no fixed public package constant. The official default relayer configuration inspected on 2026-10-25 reported Mainnet package `0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5`. The adapter pins this inspected package plus `::account::MemWalAccount`. A future package migration fails closed until this pin and its evidence are reviewed; it does not automatically trust any newly returned type.

Transport accepts only HTTPS on the exact official Tatum Mainnet gateway root, with no credentials, port, query or fragment. The key is sent in `x-api-key`. Redirects are errors, each call has a 10-second deadline, and each response is limited to 65,536 bytes. Errors use fixed codes. Identical checks coalesce in process and cache for 60 seconds; deployments with multiple processes need shared quotas before increasing exposure. Successful `latestProof` includes provenance, timestamp, chain ID, object version and explicit `authorizationVerified: false`; failed checks discard success to avoid presenting stale proof.

An observation establishes only what the configured RPC reported. It does not prove that the signed-in person controls the owner, that a delegate is authorized, that the account is active, that SEAL will decrypt, that a memory was uploaded, or that a Walrus archive is complete. Those remain separate authenticated SDK/live gates.

## Official references inspected

- [Tatum Sui gateway and x-api-key example](https://tatum.io/chain/sui)
- [Tatum authentication](https://docs.tatum.io/docs/authentication)
- [Sui chain identifier formats](https://mystenlabs.github.io/sui/sui_sdk/digests/index.html)
- [MemWal account SDK](https://github.com/MystenLabs/MemWal/blob/main/packages/sdk/src/account.ts)
- [MemWal shared account and stored owner](https://github.com/MystenLabs/MemWal/blob/main/services/contract/sources/account.move)
- [Official default relayer configuration](https://relayer.memory.walrus.xyz/config)

Tests use synthetic transport responses for valid observations, wrong chains, object IDs/types/owners, invalid ownership metadata, credentials, endpoint restrictions, oversized responses and redacted transport failures. They do not establish a live Tatum result.
