# Source-history production verification

Verified on 27 October 2026 at https://thesisbreak.vercel.app. This is evidence for the source-history loop, not acceptance of every product workflow.

## Recorded before the event

The signed-in browser saved the Kalshi market quote for `KXNBAGAME-26OCT27BKNBOS-BOS` after explicit Walrus consent. The server recorded it at `2026-10-27T15:10:49.805Z`; the scheduled event start is `2026-10-28T02:30:00Z`. The browser could not supply the capture timestamp or a grade.

The source is **Kalshi market quotes**, a market baseline in the **Sports:Pro Basketball (M)** cohort. It is not an independent analyst. Version 1 contains one recorded contract and zero scored final results. Its Brier score is null.

## Walrus write, readback and recovery

- Outbox state: `done`, one attempt.
- Blob ID: `OULHQnJigdPZXTxXvmRc1SPnUN3S9VfZ9VdzY0Kwzr4`.
- Payload hash: `1a4a8552d085bb2df655829c793a3a8df87a17115d9da3b93e30feb7164bbbfd`.
- A fresh SDK client recalled the owned source profile at version 1.
- Recovery matched the expected inventory: one source record, zero rejected records, no truncation. This verifies that inventory; it does not demonstrate recovery of lost database permissions or every record in the shared Walrus account.

## Hosted agent

The hosted conversation completed and its saved result contains the recalled source profile and version. The agent stated that the account has one recorded event and zero final results, that reliability cannot yet be assessed, and that the quote is a baseline. The UI exposes **Source history recalled from Walrus** with version 1 and the sample count.

The first request failed and preserved the draft; a subsequent request completed. The failure's root cause was not established, so this run does not prove outage-free availability.

## Scheduled worker

[Production workflow run 40529505125](https://github.com/maixuancanh/thesisbreak/actions/runs/40529505125) completed successfully on commit `3c072cc`. The source worker checked the live contract and made zero grading updates because no final result was available. Memory sync runs before grading in that workflow; newly generated score versions can therefore wait until the next scheduled batch for remote synchronization.

Tatum was configured separately on the web app. This workflow run did not have a Tatum key at execution time and is not evidence for a live Tatum read.

## Local regression checks

296 unit tests and 50 PostgreSQL integration tests passed. Type checking, lint and the production build passed. Coverage includes immutable pre-event capture, owner and consent boundaries, corrections and withdrawn finality, current-version validation, pause fencing, and source recall in the agent context.

## Remaining evidence

The captured event has not ended. A natural final-result transition, updated score version, subsequent Walrus write and later agent recall must be observed after a supported official result appears. No forecasts were backdated in production to manufacture a scored history. This run does not establish ten useful memories, an accuracy gain, live bookmaker access or Polymarket settlement grading.
