# Event-first V7

Implemented 23 October 2026 (Asia/Saigon), based on research/thesisbreak-binance-pick-jupiter-ux-v7.md.

Discover uses compact grouped event cards with a persistent contextual Thesis panel. Official source event identity groups conditions without changing native market/outcome identities. Select a condition, then an outcome to draft; Discuss retains the case context. Existing account/review/idempotent save boundary stays in place. Discussion drafts are session-only and separated by platform/native ID/provider. No AI reply is generated while unconfigured.

Public Kalshi discovery uses nested official events, plus a labelled first-page selection of up to six upcoming NBA game events (KXNBAGAME); only future active contracts enter that selection. If it fails, general discovery still works and no featured claim is shown. General pagination remains the official event cursor. Only exact, source-declared exclusive Game conditions with unique source labels render participant buttons. Each button maps to that participant's own native Yes contract. Other contracts retain their original condition selector and Yes/No labels. No team or odds inference is used.

Category and search apply only to loaded records. No global search is claimed. Images are official provider-returned URLs restricted to known asset hosts; native market images are matched by ID, with fallback for missing artwork. Scheduled time comes from occurrence_datetime or a validated explicit-zone gameStartTime, never close_time. Year/timezone remain visible. Invalid optional schedule no longer discards valid event identity. Decimal-strike Kalshi IDs are accepted unchanged and URL-encoded.

Data connections and fictional samples are secondary disclosures. My picks retains its real-account API and compact saved view/reason layout; no monitoring status is invented. Optional favorites and tournament/clan/rewards features were not added.

## Verification

- 116 unit tests passed; TypeScript, ESLint and production build passed.
- Three offline integration tests passed; six PostgreSQL tests explicitly skipped without TEST_DATABASE_URL.
- Local production server restarted at http://localhost:3013.
- Live HTTP: first page 200, 143 contracts across 26 events including labelled NBA selection; second page 200 with 214 contracts across 20 events. Exact decimal-strike detail identity matched at 200. Counts are a snapshot and may change.
- Real official NBA event fields returned participant condition labels, source images, Game scope, exclusive event semantics and separate occurrence times.
- Initial V7 desktop was visually inspected in the in-app browser: two-column cards, sourced images, categories and right Thesis panel rendered. A later browser reload returned Local browser use is disabled in Work settings. Final participant-layout interaction, draft roundtrip and mobile browser verification therefore remain pending; no screenshot of the final revision was captured. No alternative browser-control mechanism bypassed that setting.
- Public Polymarket still returns source unavailable from this environment; no mock fallback. Tatum/auth/database/LLM/Walrus credentials remain absent, so no authenticated save, model response or Mainnet memory proof is claimed.
