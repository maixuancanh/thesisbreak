# Live catalog

Discover opens in Live markets mode. Fictional fixtures are available only through the separate Sample preview toggle. The live interface calls `/api/live-markets` with `platform`, `limit=20`, optional `provider=tatum|public`, and an opaque `cursor` returned by the server. Automatic source selection is controlled by the server.

“Filter this page” filters loaded questions locally. It does not promise complete platform coverage. Refresh replaces the loaded pages. Platform/source changes abort earlier requests and discard stale responses. Failures display an error and retry control; they never fall back to fixtures.

Details use the exact platform/native market ID and display the returned outcomes, rules, source URL, and timestamps. Prices are displayed in cents with their source basis. Kalshi's YES last-trade price is shown only when traded volume is positive; its unavailable NO price stays null. Polymarket uses its supplied outcome prices without calculating a complement. Untraded zeros are not displayed as implied probabilities.

Detail links preserve the resolved catalog provider as `?provider=public|tatum`. The server page validates that value before forwarding it to the detail request, so public catalog navigation does not silently switch to Tatum when a key is configured. Direct links without a provider use server automatic selection. Detail responses for a different native ID are rejected.

The right Thesis panel starts visible. Its AI connection is explicitly unconfigured. Drafts live only in an in-memory map scoped by the exact platform and native ID and survive navigation during the session. They are separate from fictional preview storage and authentication. Reloading clears them. Live pick saving is not implemented; the account link does not claim a persisted pick.

Client DTO validation uses Zod in `apps/web/lib/live-market.ts`. Server provider implementation owns credentials, normalization, pagination, and error responses. Build/type/lint checks establish code validity; live provider operation requires separate HTTP verification. Browser testing was not performed for this change.

## Verified public source access

On 22 October 2026, the Node adapter retrieved a 20-market Kalshi page from the official `https://external-api.kalshi.com/trade-api/v2/markets` endpoint without credentials. A separate detail request matched the selected native ticker and returned actual resolution rules. Polymarket's Gamma host returned `ECONNREFUSED` from this machine; no proxy or sample fallback was used. Both are separate from Tatum, which remains unverified without its project key.

Automatic selection uses Tatum when a key is configured and the public source otherwise. Users can explicitly choose either transport. Failure of the chosen transport stays an error; it does not silently switch providers. Thirty-second successful-response caching, in-flight coalescing, bounded payloads and per-process upstream quotas protect the local preview. Distributed quota enforcement and authenticated live-pick persistence remain separate work.


V6: Kalshi markets include eventId and eventTitle when the exact official event endpoint returns matching identity. Four concurrent workers and a five-minute bounded event cache limit enrichment calls; failure retains the native event ID without fabricating a title. Live pick creation uses the selected public/Tatum catalog and server-fetched rules. Null outcome prices stay null. Event context and provider are retained in snapshot raw data and returned with account picks. Local HTTP proof: 20 markets/20 event titles with matching exact detail identity on 22 October 2026. This does not establish Polymarket reachability or configured Tatum access.
