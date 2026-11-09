# Independent evidence implementation

Approved scope: connect official NBA injury reports, BALLDONTLIE NBA schedules/injuries/lineups, official team announcements and Federal Reserve monetary-policy releases. Root owns integration, database, agent and watch behavior; Sol 6.1 agents own NBA PDF and official feed parsers. Existing Google authentication, reviewed mutations and Walrus consent rules remain authoritative.

Implementation gates:

1. Fixed-host bounded connectors, maintained PDF/XML parsers, no model-generated source facts. Keep publication time separate from retrieval time. Missing API key, unsupported team and provider access failures must stay visible.
2. Event mapping uses reviewed native NBA game identity plus exact date/team metadata. Unmapped markets receive no automatically attributed news. Fed releases are background context unless an exact event relation is established. Injury reports do not confirm starting lineups.
3. Persist source checks and immutable evidence receipts. Agent reads server-owned evidence and can cite it. Market watches compare exact player/status facts; unchanged or missing data cannot imply that the user's reason is wrong. New alerts require an active, current-version, unexpired watch and deterministic reason relevance. No automatic pick edits or memory writes.
4. Account UI exposes source status and excerpts with original links. Walrus-approved preferences remain part of the agent context; new lessons still require explicit review and consent.
5. Run parser/transport/ownership/database tests, live read-only public source checks, type/lint/build. API-key and paid-tier live checks remain blocked until the user supplies credentials; do not subscribe or spend on their behalf.

## Using the integration

Open a real event and expand **Independent sources** in the Thesis panel. **Check sources** shows what was retrieved, its original link, publication time where supplied, and retrieval time. Source material is read as untrusted evidence; embedded text cannot approve actions or change tool permissions. Every research turn also reads these server-owned sources, even if the planner omits a source read. The same turn continues to check current approved Walrus preferences. Citations identify the NBA report, team newsroom or Fed rather than calling every source a saved snapshot.

The mapped NBA scope is the inspected Kalshi `KXNBAGAME` binary game contract format. Exact date and both teams are required. NBA PDF player records retain the full matchup and player-team attribution. A source with no matching rows does not confirm availability. Other market formats, including Polymarket, are explicitly unmapped for automatic NBA status alerts. Their Fed feed is labelled background context, not event-specific evidence.

**My picks → Watch this market** offers an unchecked independent-news option. Confirm it to enable official NBA player-status alerts. Existing watches remain market-only. A full player name in the saved reason is required; abbreviated or fuzzy names do not trigger alerts. The first report establishes a per-watch baseline. A later explicit status transition produces a notice in **This week**. Missing rows, no new report, unrelated announcements and price changes never become a claim that a reason is disproved. Watch ownership, current pick version, deadline, lease and attempt are rechecked when committing. Pause/restart resets its baseline; another user's watch or a chat refresh cannot consume it. Repeated genuine transitions in later reports remain distinct from retry duplicates.

Source checks are cached for five minutes. Immutable evidence content versions are archived separately from current source health. A failed check does not erase an earlier receipt, but failed source rows are excluded from agent evidence. Partial BALLDONTLIE responses retain their partial label. Current injury snapshots without a game timestamp are background information. Neither an injury report nor an empty lineup response establishes who starts.

## Provider configuration

Public NBA reports, all 30 reviewed team newsroom routes and Fed RSS do not require an application API key in the current connector. The team connector uses canonical newsroom listings or fixed official NBA content endpoints for the few sites with different layouts. Their availability can change; unsupported responses fail closed rather than being replaced with examples.

The owner chose to continue with public sources without a BALLDONTLIE key. Its adapter remains installed and tested, but live access is not claimed. To enable later, put `BALLDONTLIE_API_KEY` in the ignored project `.env`. `BALLDONTLIE_FEATURES=games` is the default. Set `injuries` or `lineups` only with provider access to that feed. The connector validates the exact game before attaching data, bounds pagination and exposes access/rate-limit failures. It does not buy a plan or infer lineups from injury records. Official documentation: [BALLDONTLIE](https://docs.balldontlie.io/).

## Verification

`pnpm check:sources` performs read-only public source retrieval and archives public evidence; it does not write Walrus memories or change a user pick. Private acceptance output is `.local/independent-sources-proof.json`. A real Lakers–Jazz contract returned seven matched NBA player rows, both team newsrooms and the expected missing-key state for BALLDONTLIE. The independent Fed check returned 15 releases, explicitly labelled background and an unmapped test target. All 30 team routes were individually read successfully during connector validation; this proves listing retrieval, not complete historical coverage or a verified lineup.

`pnpm check:news-agent` uses the existing labelled acceptance account and its previously approved memory, reads the actual public report, and invokes the configured model. The latest result cited the official report and referenced one approved Walrus preference, with zero new remote writes. Private output: `.local/news-agent-proof.json`. This is not a ten-memory or adoption claim. Parser fixture tests, authenticated API boundaries, exact market storage and PostgreSQL watch fencing/repeated transitions also pass. A live injury-status change was not manufactured to demonstrate an alert.

Official sources: [NBA injury-report index](https://official.nba.com/nba-injury-report-2026-27-season), [Fed RSS directory](https://www.federalreserve.gov/feeds/feeds.htm). The NBA PDF's publication timezone is not guessed; publication time remains unknown when not reliably parsed. Retrieval time is never presented as publication time.
