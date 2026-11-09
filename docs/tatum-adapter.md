# Tatum catalog adapter

The adapter calls Tatum's documented Prediction REST endpoints on a fixed HTTPS host. It is deliberately small: the inspected published Tatum SDK did not establish typed support for these calls. Runtime parsing uses the documented OpenAPI fields rather than the older hackathon adapters' backend assumptions.

## Available server endpoint

`GET /api/markets?platform=polymarket&limit=20` lists markets. Use `platform=kalshi` for Kalshi browsing. `GET /api/markets?platform=polymarket&id=CONDITION_ID` fetches one market; Kalshi uses its uppercase ticker. Missing credentials return HTTP 503 with `TATUM_NOT_CONFIGURED`. Invalid queries return 400; provider access errors are distinct from an empty result.

List filters `status`, `category`, `tag`, `search` and `minVolume` require `platform=polymarket`. Unsupported combinations are rejected before a paid API call. `eventId`, `endingBefore`, `sort`, `limit` and cursor are validated separately. The next cursor is an object containing the unmodified upstream value and the adapter's query fingerprint; pass its JSON representation as `cursor`. Changing filters or page size invalidates that wrapper. The wrapper is not authorization or a signature; Tatum also validates its own opaque cursor.

## Data semantics

- Identity is the native ID plus platform. A detail response for another identity is rejected.
- Source links must be canonical HTTPS links on the claimed platform; they are not fabricated from a question slug.
- Description is retained as the available rules text, or null. No rules are invented when a description is absent. Market description is not guaranteed to be a complete settlement policy; follow the source for the full terms before approving a live pick.
- Market chance comes from the returned outcome price. `fetchedAt` is the application's retrieval time. The catalog does not provide an independent price publication timestamp, so `priceAsOf` stays null.
- Kalshi volume remains a contract count and its missing liquidity stays null. No USD placeholder or inferred chain reference is inserted.
- Catalog coverage is market data only. Tatum market records do not establish football lineup coverage or verify news claims.

The route coalesces identical in-flight calls, caches successful responses for 30 seconds and caps upstream calls at 30 per minute per process. Its cache holds at most 100 entries. This is a local cost guard, not a distributed abuse-control guarantee. Shared quota enforcement is required before an unrestricted multi-instance production release.

## Verification limits

Offline contract tests use invented rows matching the official documented shape, injected fetch responses, and errors. No Tatum credential was supplied, no live catalog was loaded, and the browser preview remains fictional. Do not mark the task live-verified until authenticated response schemas, rights, request costs and actual market identities have been checked.

Official sources inspected 22 October 2026:

- [List prediction markets](https://docs.tatum.io/reference/getpredictionmarkets)
- [Get a market by ID](https://docs.tatum.io/reference/getpredictionmarketbyid)
- The same pages' `.md` versions provide their OpenAPI definitions.
