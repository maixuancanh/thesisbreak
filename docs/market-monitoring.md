# Market-source monitoring

Start from My picks → Watch this market, review the scope and choose 24 hours, three days or seven days. The watch binds the exact saved pick version and catalog provider. It polls native market prices and settlement rules every five minutes. This is market-source monitoring, not independent news ingestion, a lineup feed or a claim that your reason has been disproved.

```powershell
pnpm exec tsx scripts/market-worker.ts
```

`--once` handles one due watch. PostgreSQL persists the deadline, last observation, next check, source health and a lease. Claims use SKIP LOCKED and an incrementing attempt token. A stale worker cannot commit after pause, expiry, version change or a later claim. Source failure generates a delayed-data notice, never a reassuring “no change.” Changing the pick supersedes its current watch; review the new version before watching again.

This week shows persisted updates with a link to discuss the exact market. Price changes and changed settlement rules have distinct labels. Repeated identical observations are deduplicated. Missing rules/prices are incomplete data. No worker changes a pick or approves a lesson. Pausing prevents new notifications after the pause commits; previously recorded notices remain visible.

Public Kalshi and configured Tatum adapters are used as selected; a failed Tatum watch does not silently switch provider. Polymarket transport availability and Tatum credentials need separate live checks. Independent news/official-lineup coverage still needs a supported licensed source and verified event mapping. The full plan's assumption-change evaluator remains pending that evidence ingestion.

## Final result comparison

For public Kalshi watches, the worker accepts a binary result only when the market is `finalized`, has a Yes/No result, a settlement timestamp no later than the fetch, and a matching 0/1 settlement value. Provisional markets, scalar payouts, missing timestamps, closing prices and merely `determined` results do not qualify. Kalshi omits the false `is_provisional` field on ordinary markets; true means the market may be removed, rather than describing the settlement's finality. See the [official endpoint](https://docs.kalshi.com/api-reference/market/get-market) and [OpenAPI field descriptions](https://docs.kalshi.com/openapi.yaml).

This week shows the source result beside the watched pick version. Entries saved at or after the settlement timestamp are not scored. A later source correction creates a separate notice. An unavailable result does not erase the previous settlement receipt. These comparisons do not evaluate whether the original reasoning was sound or establish prediction accuracy. They do not change picks, create lessons or upload new memory without consent.

On 25 October, a read-only live check of `KXNBAGAME-26OCT24GSWPHX-PHX` returned finalized Yes with settlement timestamp `2026-10-25T04:35:32.504449Z`. The normalized adapter returned the same result. Database tests cover the notification, exact pick version, source correction and exclusion of entries saved after settlement. No authenticated browser result-card check is claimed. Tatum and Polymarket final-result mappings remain pending; the worker does not infer results from their prices. Only watches active within their reviewed deadline are checked.

Worker availability: database/claim failures retry with bounded exponential backoff; idle pool errors are logged without raw payloads. Restarted workers keep database leases, fencing and deduplication intact. `--once` reports a failure to the operator rather than looping indefinitely. Workers need a service supervisor in production; retrying does not replace database availability or backup validation.
