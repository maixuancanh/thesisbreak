# Current memory inventory and exact final readback — 5 November 2026

At 2026-11-05 01:11:31 UTC, a read-only production audit found 27 current consented forecast artifacts with 27 distinct blob IDs, 27 distinct content hashes and 27 distinct forecast/version pairs. Nine current artifacts contain final results. These are forecast memories, not user-approved lessons.

The audit selected all nine current final artifacts and one current initial forecast artifact. Fresh remote recall verified **10/10 selected artifacts, including 9/9 finals**, against the current database authority. The safe [inventory JSON](judging-memory-inventory-2026-11-05.json) lists each artifact reference, blob ID, hash, version, result status, capture time and utility. It excludes owner IDs, runtime configuration and raw memory contents.

| Selected artifact | Version | Result | Fresh exact readback |
|---|---:|---|---|
| d8fbea434fae9ec9 | 2 | final | verified |
| 602155e5a1852911 | 2 | final | verified |
| 0ba8e6d858715d04 | 2 | final | verified |
| a3d2f22348b3c976 | 2 | final | verified |
| 43a96225300c042e | 2 | final | verified |
| f9608c25651a96bc | 2 | final | verified |
| fb799b6b792a0200 | 2 | final | verified |
| d564df37d991ea44 | 3 | final | verified |
| 28bb29f57c008ee1 | 3 | final | verified |
| f34437c39090484d | 1 | awaiting result | verified |

Final artifacts preserve the original pre-event forecast alongside its official-result record for calibration and reasoning audits. The initial artifact preserves a timestamped forecast for later scoring. Those are candidate uses, not evidence of improved predictions. The inventory explicitly reports **0 human-reviewed useful memories and 10 unreviewed usefulness candidates**. This audit neither approves a lesson nor records any review on the user's behalf. Human usefulness review, a demonstrated later agent use, and forecast improvement remain separate evidence gates.

The earlier lifecycle audit recalled the newest four forecasts per owner. Because newer initial forecasts displaced older final forecasts, that bounded selection returned no finals. It did not demonstrate missing final blobs. The new optional targeted selector narrows the existing `recallNbaForecastMemories` query to at most four forecast IDs per call. Defaults are unchanged. The current-version, live namespace, owner, consent, capture/result timestamp, exact blob/hash/type/logical ID/version/payload checks and in-flight permission recheck all remain in force. Each of the ten audit calls selected one artifact; there were no remote writes or grants.

Reproduce from the repository root with `node node_modules/tsx/dist/cli.mjs scripts/audit-judging-memory.ts --verify-memory`. The script reads the existing private `.local/production-runtime.env`, emits only the safe allowlisted report, and does not print provider exception messages. Without `--verify-memory`, it reports receipt inventory only. Counts are scoped to current consented live forecast artifacts and do not claim full account inventory or all historical versions. Consent and versions can change after this observation.

Validation: six targeted recall unit cases passed, covering exact final acceptance, version/hash/payload rejection, revocation during the read and selection budget rejection. TypeScript validation passed. No hosted browser journey or actual later agent tool use was exercised here.
