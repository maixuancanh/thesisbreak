# Source history

Open a live market, expand **Remember a source for this event**, and choose **Remember current market quote**. You can also record an external forecaster's exact outcome, stated probability and link. External forecasts are labelled as reported by you; the app does not verify their authorship.

Each forecast receives a server timestamp. Only entries recorded before a known event start can be scored. Unknown starts stay unscored. Probabilities are optional; the app never extracts a numeric probability from prose.

Final binary Kalshi results come from its public API. The worker checks the contract identity and rules before grading. Withdrawn finality retracts the grade, and corrections replace earlier results. Older results receive slower reconciliation checks. Polymarket source records can be saved and recalled, but their settlement grading is not yet enabled.

Source records are private to an account and category/competition. Summaries cover the latest 50 recorded contracts for that source, with outcome matches, sample counts and Brier scores when an explicit probability exists. Market quotes are a baseline, not an analyst or independent news report. A small record cannot establish reliability.

Saving requires explicit Walrus consent. A durable outbox writes a versioned record, verifies its receipt and reads back the exact content. New conversations retrieve the record from Walrus, recompute its scores and compare it with the account's current version. Foreign, altered, outdated and paused records are excluded. Account records never substitute for a missing Walrus readback.

**Pause source** stops future use and pending writes. It does not erase an existing Walrus blob. Resuming creates a fresh version. Storage and recovery includes source-history records alongside approved preferences.

Run `pnpm worker:sources --batch` to check a bounded set of markets, then `pnpm worker:memory --enable-remote-writes --batch` to process consented memories. Production uses the scheduled account-jobs workflow. The web route also starts one owned memory write after responding; scheduled jobs retry unfinished work.
