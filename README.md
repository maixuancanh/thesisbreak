# THESISBREAK

Remember why you made a pick. Talk it through when the evidence changes.

**Review my reason** asks Thesis to assess the saved reason against supplied evidence. **Learn from this result** separates a verified final Kalshi outcome from the quality of the reasoning. Suggested lessons open as editable drafts and still need explicit review and Walrus consent. No chat reply automatically changes a pick or approves a memory. See [the reasoning loop](docs/reasoning-loop.md) for scope and verification.

THESISBREAK is being built as a prediction journal with a conversational thinking partner. It keeps the market question, your reason and the evidence in one place. Approved lessons are intended to carry into later cases through Walrus Memory.

## Current state

Web: [thesisbreak.vercel.app](https://thesisbreak.vercel.app/) · Source: [GitHub](https://github.com/maixuancanh/thesisbreak).

The hosted app supports Google sign-in, live public Kalshi discovery, account-backed conversations and Walrus source-history recall. On 27 October 2026, a forecast saved before its event start was written to Walrus, read back with a fresh SDK client and used by the hosted agent. The selected deployment uses free tiers; see [deployment setup and limits](docs/deploy-free.md).

Discover uses actual catalog APIs and keeps fictional samples behind an explicit toggle. Authenticated picks, research conversations and reviewed preferences use PostgreSQL. Memory supports approved, scoped preferences with edit, pause and retire controls, plus a durable Walrus outbox worker. This week counts actual account activity and preference references. The app does not place trades.

Official NBA reports, team newsrooms and Fed releases are integrated with explicit coverage limits. Tatum credentials are configured on the hosted web app; configuration alone does not prove a forecast-linked onchain comparison. Ten useful production memories and forecast-accuracy improvement are not established.

Latest update: [source track records](docs/source-history.md) capture predictions before events, reconcile supported Kalshi results and publish consented, versioned summaries to Walrus. Agent recall verifies the remote payload against current account authority. The latest suite has 296 unit tests and 50 PostgreSQL integration tests; type checking, lint and production build pass. The scheduled production worker completed a real source check. The captured event has not finished, so its score remains unknown. See [hosted verification](docs/source-history-production.md) for receipts, workflow evidence and remaining limits.

Check [hosted verification](docs/source-history-production.md) for the separate database, provider and production gates. An offline adapter test does not establish a Mainnet write or successful recovery from a production account.

## Local setup

Use Node.js 24 and the pnpm version pinned in `package.json`.

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
pnpm typecheck
pnpm lint
pnpm test:unit
```

The web workspace starts with:

```powershell
pnpm --filter @thesisbreak/web dev --port 3013
```

Open `http://localhost:3013`. Browser verification of the interface is a separate step; see the status document for the latest evidence.

## Provider configuration

Fill the server-side settings in the project root `.env`; the web configuration loads this file without overriding deployment-injected variables. Keep secrets out of browser bundles and source control. Prefer a dedicated Walrus delegate. The owner explicitly authorized reuse of existing LLM, Walrus and Google OAuth configuration for this local build; THESISBREAK still uses its own database, session secret and per-user namespace.

```powershell
pnpm smoke:providers
```

This diagnostic is read-only. It reports missing configuration as blocked and does not write memory or sign transactions. See [provider capabilities](docs/provider-capabilities.md) and [the SDK adapter](docs/memwal-adapter.md).

## Database

Set `DATABASE_URL` for a dedicated PostgreSQL database and run `pnpm db:migrate`. Migrations have been applied locally. Use a separate database and `TEST_DATABASE_URL` for integration tests, then run `pnpm db:migrate:test` and `pnpm test:integration`. Tests skip database cases when that variable is absent. On this Windows setup, `pnpm db:local` provisions separate app and test databases using the installed PostgreSQL 16 binaries; it does not use another application's database.

## Memory and sign-in

Register `http://localhost:3013/api/auth/callback/google` in the Google OAuth client's authorized redirect URIs for local development. Use the equivalent HTTPS callback on a deployed host. Keep existing callbacks when sharing an OAuth client.

After sign-in, discuss a market and open **Teach Thesis for next time**, or visit **Memory**. Write the preference, review its category and optional competition, then explicitly approve remote storage. The account save is queued; only exact Walrus readback produces a verified receipt. Run the worker separately:

```powershell
pnpm worker:memory --enable-remote-writes
```

The worker uploads explicitly consented lesson and source-history versions. Historical picks and chats are not uploaded automatically. Pause and retirement take effect through current account authority; they do not delete existing blobs. Resuming asks for a new consented version. See [worker details](docs/memory-worker.md).

`pnpm check:agent` checks structured generation and read-only recall in an empty isolated namespace. The live acceptance script `pnpm exec tsx scripts/verify-memory-journey.ts --write-mainnet` writes one labelled test lesson and checks cross-session reuse. Run it only when intending a real remote write; it is not a method for padding submission memory counts.

## Watching a market

Independent sources are now available in the Thesis panel: official NBA injury reports for mapped Kalshi NBA games, official team newsrooms, and Federal Reserve releases as background for other markets. Replies cite retrieved evidence alongside approved Walrus preferences. When reviewing a watch, explicitly enable NBA player-status changes to receive notices related to a named player in your saved reason. Existing watches remain market-only. BALLDONTLIE is optional and currently unconfigured; no paid feed access is claimed. See [source integration and verification](docs/independent-sources.md).

Open My picks, select **Watch this market**, review the exact saved version and choose a deadline. Run `pnpm worker:markets` separately. This week shows price/rules changes and source outages; these updates do not claim to identify changed team lineups or disprove your reasoning. [Monitoring details](docs/market-monitoring.md) explain the scope and restart behavior.

Run status reconnects through SSE and can be cancelled with confirmation. The saved result survives navigation, but the original generation request is not a durable execution worker. See [run status](docs/run-stream.md).

Memory → Storage & recovery audits your owned receipts and, after confirmation, rebuilds the remote index against the expected archive. It does not reinstate paused lessons or rebuild lost database permissions. [Recovery details](docs/memory-recovery.md) distinguish inventory verification from full recovery.

## Reviewing your reasoning

In an event conversation, **Review my reason** prepares a request to check your saved rationale against the sources available to Thesis. For supported public Kalshi final results, **Learn from this result** separates the outcome from the quality of your reasoning. Send the request to get the review. A suggested lesson can be edited and reviewed; it reaches the Walrus queue only after your explicit approval. A correct outcome alone does not establish good reasoning.

`pnpm eval:research --live-model` runs four fixed synthetic cases with and without an existing approved Walrus preference, using eight model calls and no new memory writes. Both variants passed the label/citation checks in the recorded run. That confirms regression behavior and memory use, not improved forecast accuracy. See [evaluation scope and results](docs/research-evaluation.md) and [result review](docs/reasoning-loop.md).

## Reused code

The application uses maintained dependencies for validation, persistence and memory transport. Component imports retain their original notices. [Code reuse decisions](docs/code-reuse.md) record which source was inspected, what was used and why some modules were unsuitable. [Third-party notices](THIRD_PARTY_NOTICES.md) track imported components.

Project-specific code handles permissions, versions, reviewed changes and lesson applicability. The official Walrus Memory SDK handles its supported relayer protocol; the application does not reimplement its signing or encryption.

