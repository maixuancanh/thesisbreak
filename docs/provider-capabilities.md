# Provider capabilities

Updated 22 October 2026. This is the initial implementation record. Documentation review is not an authenticated provider test.

| Provider | Intended role | Current status | Remaining proof |
| --- | --- | --- | --- |
| Tatum Prediction Markets | Market catalog, exact identity, rules, outcomes and timestamps | BLOCKED: no project credential configured | Both platforms, schema normalization, filters, stale/error states |
| Tatum Sui RPC | Read the account/object used by memory workflow | BLOCKED: RPC URL and account absent | Correct network, object identity/type/owner and applicable permissions |
| Walrus Memory | Durable approved records, recall and index restore | Official SDK 0.1.9 adapter compiled and tested offline; live BLOCKED: project account/delegate absent | Mainnet write/readback, production recovery and receipt audit |
| LLM | Contextual debate, evidence assessment and proposed edits | Official AI SDK binding and scoped context compiled/offline tested; live BLOCKED: project model/key absent | Real generation, streaming, semantic citation support and end-to-end permissions |
| PostgreSQL | Authorization, versions, jobs and idempotency | BLOCKED: connection absent | Fresh migration, race/tenant tests and restart |
| Football source | Official lineups tied to the correct event | BLOCKED: provider not selected | Rights/coverage, event mapping, timestamps, freshness and quota |

## Configuration

Copy `.env.example` to `.env` in the project root and fill only the project's own credentials. Server secrets never belong in `NEXT_PUBLIC_*` variables. The initial read-only command is `pnpm smoke:providers`; exit 2 means blocked, exit 1 means a probe failed. A PASS from a catalog HTTP probe only establishes authenticated JSON transport, not correct domain mapping or complete API coverage.

25 October update: the owner explicitly authorized using DON’T FORGET ME's LLM, Walrus and Google OAuth configuration. The server configuration is local and ignored by source control. THESISBREAK has its own database/session secret and server-derived namespaces; no game memories were imported. Structured generation and read-only isolated recall passed. One labelled acceptance lesson was written, exactly read back and used by the model from a fresh SDK client in another scenario. This does not establish ten memories, browser sign-in or production recovery.

The file-based game LLM configuration returned HTTP401. Its private deployment gateway configuration was reused on loopback, where actual inference succeeded with the configured Terra model. Google authorization redirects correctly, but its existing OAuth client rejects the new localhost callback until it is registered. PostgreSQL migrations and all 18 integration tests passed against separate local app/test databases. Tatum remains unconfigured.

## Integration constraints

- Tatum exposes both prediction platforms; feature parity must be checked per endpoint. Official unified search documentation describes Polymarket support. Keep capability-aware UI for Kalshi.
- Application memory operations need explicit consent and policy checks. Automatic conversation capture is not approval of a lesson.
- Preserve logical identity and hashes outside semantic search. An uncertain write must be reconciled before retry; repeated provider writes can create duplicate records.
- Restore needs a completeness check against the expected inventory. A successful recovery response alone does not prove every expected record was recovered.
- Namespace selection is server-controlled. It supplements authenticated application checks; users cannot request arbitrary namespaces through the API.
- Retirement, index removal and physical blob deletion are distinct outcomes. Expose only lifecycle actions actually supported and verified.

## References checked for implementation planning

- [Tatum Prediction Markets](https://tatum.io/products/data-api/prediction-markets)
- [Tatum unified search](https://docs.tatum.io/do/reference/getpredictionsearch)
- [Walrus Memory repository](https://github.com/MystenLabs/MemWal)
- [Walrus Memory integration reference](https://github.com/MystenLabs/MemWal/blob/main/SKILL.md)

The detailed Tatum catalog reference was inaccessible through the research tool in this turn. Validate the installed SDK and actual response schemas when credentials are available; do not infer compatibility from examples alone.
