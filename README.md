# THESISBREAK

THESISBREAK is a prediction journal with a research assistant. It keeps the reason for a pick alongside the market terms and the evidence available at the time. When something changes, you can see which assumption it affects, what still needs checking, and whether you want to revise your view.

[Open the live app](https://thesisbreak-live.vercel.app/) · [Read the build story](docs/total-recall-build-story.md)

Built for **Markets & Sports Prediction** at Walrus × Tatum Total Recall.

## Why I built it

A pick can outlive its reasoning. The market records an outcome and a price, while the reason for choosing it might be buried in a chat or a news tab. A day later, a headline moves the price and it is hard to tell whether the underlying assumption changed. After the result, a winning pick can make a weak argument look sound.

I built THESISBREAK around that review process. You can record a condition such as waiting for an official NBA starting lineup, keep it with your pick, and return to it when a report appears. Thesis retrieves the relevant context, checks the evidence it can reach, and explains what would justify a change. You decide whether to keep the pick, update it, or stop watching it.

## Try the app

1. Open [Markets](https://thesisbreak-live.vercel.app/) and choose a Kalshi or Polymarket event. Sign in with Google to save your work.
2. Ask **Thesis** about the market, then save a pick with a reason and an optional **Revisit if** condition. For a Polymarket market, use **Sources → Check trades** to see a sample of finalized Polygon matches.
3. Open **My picks** to review the original reason or start a watch. **Today** shows evidence that needs attention and **This week** shows account activity and watch updates.
4. Use **Research details** under a reply to inspect the sources checked, memory used and available receipt. Visit **Memory** to review preferences and manage what Thesis can use in later conversations.

## What the app does

| Area                 | What you can do                                                                                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Market discovery     | Browse, search and filter live Kalshi and Polymarket events. Open the exact outcome, price history, market terms and settlement information when the provider supplies it.                                           |
| Thesis conversations | Ask for an explanation, challenge a reason or check what changed. Follow source citations, review the research steps, and flag a claim that needs a correction. The assistant uses ChatGPT.                          |
| Pick journal         | Save a pick with its reason and market context. Review old and new evidence, see related picks that share a recorded condition, and confirm any change yourself.                                                     |
| Watches and reviews  | Watch prices, rules and results. Supported NBA watches can also check official reports about a named player. Review a finding, keep or update the pick, or stop the watch.                                           |
| Results and recaps   | Compare a supported final result with the original reasoning. See which conditions held up and review a proposed lesson for future research.                                                                         |
| Memory               | Save approved preferences, consented chats and supported decision or forecast records. Edit, pause or retire a preference, and inspect the receipt and recovery views for records that have been verified.           |
| Source track records | Follow a source, record what it predicted before an event, and compare eligible calls with final results. Thesis can use the resulting history in a later review.                                                    |
| Forecast ledger      | Capture eligible NBA forecasts at fixed pregame horizons, retain the original input and model version, and score them against verified results. The ledger separates live forecasts, workflow tests and replay data. |

Coverage depends on the event and source. Official NBA reports, team newsrooms and Federal Reserve releases serve different questions. An injury report can establish a reported status. An official starting lineup is a separate check.

## Walrus Memory

When a user consents to storing a conversation or approves a preference, THESISBREAK writes a versioned record through the Walrus Memory SDK on Mainnet. The application reads the record back and compares the returned blob ID and content hash with the expected record. Account ownership, consent and the current version also govern whether Thesis can use a record in a new session.

Memory is available before the agent chooses its research steps. A saved lineup condition can lead it to check official sources and wait for confirmation. A paused or superseded preference no longer governs future research. A proposed change or lesson still goes through explicit user review.

| Public submission identifier               | Value                                                                                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Walrus MemWalAccount object on Sui Mainnet | [0x96542f896898b0128c60898867d4f9d1940ebb315b5b4e2e6e719300e38ffa83](https://suiscan.xyz/mainnet/object/0x96542f896898b0128c60898867d4f9d1940ebb315b5b4e2e6e719300e38ffa83) |
| MEMWAL_AGENT_ID                            | `3d89f3bc5ee1963358e934c2d58917d3350c5e8f6518dcd81b8867225ef91966`                                                                                                          |
| Tatum Account ID                           | `6a1b1b77a02f9b2503c82e5f`                                                                                                                                                  |

## What Tatum verifies

Tatum supplies market quotes and history. For Polymarket, Thesis also reads finalized Polygon exchange events and checks the outcome token IDs for the selected market. The Sources panel reports matched order counts, matched volume, average matched price and transaction links for the sampled blocks. The sample describes trading activity during that interval.

Tatum Sui RPC checks the configured Walrus account object. In a verified receipt, **Research details** displays the Sui checkpoint and account link alongside the Walrus blob ID and readback hash. These are separate checks. The account lookup establishes the Sui object, and the readback establishes that the SDK returned the expected memory bytes.

## What I verified

| Check                                                 | Observed result                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Walrus Mainnet readback                               | On November 9, 12 of 12 distinct live NBA forecast records matched their production blob IDs, hashes and versions on fresh SDK reads. The ledger recorded 127 forecast and result blobs across 43 events at that checkpoint.                                                                                                                                                                                              |
| Cross-session recall on the current production domain | On November 9, a labelled lineup workflow test wrote a consented chat to Mainnet. A fresh SDK read matched the saved blob ID and hash. A new general chat recalled the exact source conversation, quoted its official-lineup condition, and linked back to it in Research details. A separate market-specific request checked official sources using older relevant memory. Its recall set excluded the new general chat. |
| Memory-guided research                                | An earlier recorded cross-session test used an approved official-lineup preference to check official sources and wait for confirmation. This measures observed research behavior. Forecast accuracy is evaluated separately.                                                                                                                                                                                              |
| Tatum in a live Thesis reply                          | In an authenticated production test, Thesis reported the per-outcome counts and volume in a finalized Polygon sample, explained what its empty result could establish, and cited the activity source.                                                                                                                                                                                                                     |
| Tatum Sui RPC                                         | A production receipt displayed the verified Walrus account object at Sui checkpoint 343247758 and separately showed the Walrus readback hash.                                                                                                                                                                                                                                                                             |
| Bookmaker and Polygon timing                          | Minnesota and Chicago had finalized Polygon matches in the recorded BetMGM quote windows. The same-time samples are available below. The quote feed did not identify the governing BetMGM jurisdiction, so THESISBREAK withheld a price-gap result.                                                                                                                                                                       |

| NBA home outcome                     | BetMGM margin-adjusted probability | Polygon sample in the quote window                                                                                                                                           |
| ------------------------------------ | ---------------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Minnesota Timberwolves vs. Utah Jazz |                             82.58% | 3 matched orders at a share-weighted average of 84.00¢. [Example transaction](https://polygonscan.com/tx/0xfd4242854e7641ef7ea1ab6afc35ceae6f29ec388f6297d9e25815b3bcdbdcb6) |
| Chicago Bulls vs. Philadelphia 76ers |                             20.83% | 2 matched orders at a share-weighted average of 20.98¢. [Example transaction](https://polygonscan.com/tx/0x404be6827e53a5a870daf77617d50b2cfe3eccd6f0bee6ce346969651f775eb4) |

The forecast evaluation is still collecting prospective observations. The checks above establish retrieval, source use and traceability. [Walrus readback](docs/judging-memory-readback-2026-11-05.md) · [Odds evidence](docs/total-recall-odds-evidence.md) · [Research evaluation](docs/research-evaluation.md)

## Run locally

Use Node.js 24, PostgreSQL, and the pnpm version pinned in `package.json`.

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
pnpm db:migrate
pnpm dev
```

Set `DATABASE_URL` before running migrations. Open [localhost:3013](http://localhost:3013). Configure the Google OAuth client with `http://localhost:3013/api/auth/callback/google` for local sign-in.

Use [the environment template](.env.example) for the server configuration. The main groups cover the database and session, Google OAuth, ChatGPT, the Walrus account and delegate, and the Tatum key and credit budget. Provider credentials belong in server environment variables.

```powershell
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm smoke:providers
```

For database integration tests, set `TEST_DATABASE_URL` to a separate database and run `pnpm db:migrate:test` followed by `pnpm test:integration`. The read-only provider smoke check reports configured capabilities. Run the [memory worker](docs/memory-worker.md) and [market worker](docs/market-monitoring.md) separately when testing background jobs.

## Project layout

| Path                    | Responsibility                                                   |
| ----------------------- | ---------------------------------------------------------------- |
| `apps/web`              | Next.js interface, sign-in, account routes and research APIs     |
| `packages/agent`        | ChatGPT research planning, source selection and reply validation |
| `packages/domain`       | Market, memory, review and forecast rules                        |
| `packages/db`           | PostgreSQL persistence, migrations, receipts and queues          |
| `packages/integrations` | Walrus Memory, Tatum, market and independent source adapters     |
| `scripts` and `tests`   | Workers, verification commands and automated checks              |

[Third-party notices](THIRD_PARTY_NOTICES.md)
