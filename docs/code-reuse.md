# Code reuse decisions

Updated 22 October 2026. Prefer maintained SDKs and suitable licensed source over rebuilding infrastructure. Reuse still needs an integration test: existing code does not establish correctness for a different provider, runtime or permission model.

## Implementation choices

| Area | Reuse path | Project-specific code |
| --- | --- | --- |
| Walrus Memory | Official `@mysten-incubation/memwal` SDK: storage, encryption/relayer interaction, recall and restore | Consent, namespace selection from authenticated identity, record validation, outbox reconciliation, lesson applicability |
| LLM chat | Vercel AI SDK and supported provider adapter | Authorized context, evidence references, structured proposals and confirmation policy |
| Authentication | NextAuth.js (`next-auth`); verified registry candidate 4.24.15 advertises Next 16 / React 19 compatibility and ISC license; recheck at install | Account binding, resource authorization, revocation and production configuration |
| UI | shadcn/ui source components and accessible primitives, with V4/V5 styling | Discover/pick layout, contextual chat, change review and memory controls |
| Persistence | Drizzle ORM, its migration tooling and PostgreSQL driver | Schema, transactional versions, tenant restrictions and jobs |
| Tatum | Official documented API; use an official SDK only where its installed version covers the required endpoints | Small typed adapter for normalization, capabilities, cache and error states |
| Durable jobs | `pg-boss`; verified registry candidate 12.38.0, MIT, Node >=22.12; install when worker begins | Monitoring evaluation, outbox reconciliation, source budgets and delivery keys |

Do not rebuild a relayer, encryption protocol, OAuth protocol or chat streaming protocol. Do not replace supported Tatum data with a competitor's Supabase backend merely to reuse its UI. Keep the exact provider market ID and terms.

## Source audit

Repository metadata and selected source files inspected on this date. Commits identify reviewed snapshots; installed packages need their own pinned version in the lockfile.

| Repository | Reviewed commit | License evidence | Decision |
| --- | --- | --- | --- |
| [MystenLabs/MemWal](https://github.com/MystenLabs/MemWal) | `631f639a35f182a2f7ea19ac0544bf85bfddad33` (default `dev`) | GitHub metadata: Apache-2.0 | Use published SDK; verify published declarations rather than assuming dev docs match |
| [vercel/ai](https://github.com/vercel/ai) | `36e4ce7c7f4c2a51676167634adb8c4eb3b18e77` | Actual root LICENSE: Apache-2.0; metadata alone returned NOASSERTION | Use supported packages; retain package notices |
| [shadcn-ui/ui](https://github.com/shadcn-ui/ui) | `ba1503c64472b82256d9de95e2e62c5901a38e8b` | GitHub metadata: MIT | Reuse selected components with source/license attribution when imported |
| [drizzle-team/drizzle-orm](https://github.com/drizzle-team/drizzle-orm) | `eab8bedbb65d5429c54e612ddbd88aa23091d398` | GitHub metadata: Apache-2.0 | Dependency already chosen for foundation |
| [EdgeFinder-Apps/edgefinder](https://github.com/EdgeFinder-Apps/edgefinder) | `9d4a5c0071055edc3bdbcebc702142d156a33f2e` | GitHub metadata: MIT | Selected market adapter unsuitable for direct import; no code copied yet |
| [Spagero763/bureau](https://github.com/Spagero763/bureau) | `c24f792479e7e567d3455a3604299aa9ca24d582` | GitHub metadata and prior LICENSE review: MIT | Reference caching inspected; FX-specific module not needed in this product |
| [ProjectWaja/SentinelCRE](https://github.com/ProjectWaja/SentinelCRE) | `ed5c3484f4a4ca62084467fee3eca9240bf5d6a5` | GitHub metadata: MIT | Candidate policy pattern; no direct import without module review |

### Specific compatibility findings

- EdgeFinder `src/lib/api.ts` queries its own Supabase arbitrage view, inserts fixed liquidity values and constructs platform URLs heuristically. Those assumptions conflict with exact market identity and honest missing-data handling in THESISBREAK. Do not import that module wholesale.
- EdgeFinder `cre-market-data/workflows/shared/http.ts` depends on Chainlink CRE `NodeRuntime`. It is not a drop-in HTTP client for the Next.js/Node deployment.
- Bureau `src/desk/reference.ts` is a daily FX rate module with a one-hour in-process cache. Its concept of retaining source time is useful; its currency mapping and refresh assumptions do not provide lineup monitoring.
- Polymarket, Kalshi, AlgoPicks and PROPHET public interfaces were UX references. This audit has not established reusable licensed source for those interfaces.
- GoodDrops frontend and Blokaz have no established whole-project reuse permission/source availability in the existing research. Do not copy them based on a public website alone.

## Required import record

Before vendoring a module, record original repository, commit, original path, destination, license/notice and local changes in `THIRD_PARTY_NOTICES.md`. Preserve any required license text. For dependencies, retain their distributed notices and lockfile; distinguish planned choices from installed packages.

Run domain and adapter tests after reuse. In particular, source code that returns an empty array on every error cannot silently turn a provider outage into “no confirmed change.” Keep fixtures visibly separate from live records.

Current status: foundation dependencies and `@mysten-incubation/memwal@0.1.9` are installed. The memory adapter binds to the official client and has offline tests; its independent review and live checks are separate gates. Chat/UI imports above remain implementation decisions rather than shipped integrations.

## Published SDK audit

The registry currently advertises `@mysten-incubation/memwal@0.1.9`, `ai@7.0.148` and `@ai-sdk/openai-compatible@3.0.75`. The MemWal package was downloaded for declaration/license inspection without executing package code. Its published `rememberAndWait` and `remember` declarations accept an explicit `idempotencyKey`; use this supported option alongside the application outbox instead of writing a replacement signing/upload client. Verify relayer support in contract/live tests; the presence of a client option alone is not a Mainnet result.

The SDK also exposes `destroy()` for client key cleanup. Check the shipped declarations for exact recall/restore/list APIs before writing wrappers. Repository `main` examples and the latest published package are different snapshots, so the package declarations take precedence for compilation.

The published `@tatumio/tatum@4.2.60` package was also downloaded for inspection without executing its code. Its primary `TatumApi` declaration lists token/balance/transaction methods, but no prediction-market methods. This does not prove every submodule lacks them; it means the required typed endpoint coverage is not established. Use the documented Prediction REST API behind a small adapter until a verified official client covers those calls; do not import a large SDK and claim integration merely because it installs.
