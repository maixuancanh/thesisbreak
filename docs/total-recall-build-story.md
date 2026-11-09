# What changed since I made that pick?

A pick records an outcome. The reasoning behind it is usually scattered across chat, news and market pages. I built THESISBREAK to keep the reasoning attached to the pick so I can revisit it when something changes.

Take an NBA pick that depends on a player starting. An injury update can be relevant without confirming the starting lineup. In a recorded workflow test, I approved a preference to wait for the official lineup. A later conversation recalled that preference from Walrus and checked official sources before proposing a change. When the lineup remained unconfirmed, the agent explained why it was waiting. I could see which information it used and keep control of the pick.

The journal preserves the market terms, outcome and reason as they were saved. When a market changes its terms, Thesis can retrieve the saved version and show what changed. My Picks can also surface multiple picks that share an exact reason or a confirmed condition, so one update can prompt a review of several entries. The connection describes the reasoning I recorded.

Walrus Memory stores approved preferences, consented conversations and versioned forecast records. THESISBREAK verifies a write by retrieving the expected record and matching its blob ID and content hash. It also checks that the record still belongs to the signed-in account and is still permitted for use. On November 8, I verified twelve distinct NBA forecast memories with fresh SDK reads. At that checkpoint the live ledger contained 56 forecasts and 56 result updates across 41 events. Workflow-test chats were excluded from that count.

Tatum supplies market quotes and history. On Polymarket, Thesis also checks finalized Polygon exchange events for the selected outcome tokens. I verified this in the hosted app by opening Sources, checking trades and then asking Thesis to cite the sample in a reply. Tatum Sui RPC also verified the configured Walrus account object. Research details shows that check alongside the separate Walrus blob and readback hash.

I matched two pregame BetMGM observations with finalized Polygon trades from the same time windows. The odds feed leaves the governing jurisdiction unspecified, so I left the price gap blank. [Odds evidence](total-recall-odds-evidence.md)

On November 9, I saved a new test conversation on the current production domain and matched its blob ID and hash on a fresh SDK read. A second general chat retrieved the exact conversation, repeated the condition about official starting lineups and linked to the source. A market-specific request checked official sources using older relevant memories. Its recall set did not include the new general chat.

After the result, the journal can distinguish whether the pick matched from whether the reasoning held up. It can suggest a lesson for review, and an approved lesson can change which source the agent checks next time. The current evidence shows a change in research behavior. The prospective forecasting evaluation continues.

[Try THESISBREAK](https://thesisbreak-live.vercel.app/) · [Source and setup](https://github.com/maixuancanh/thesisbreak) · [How we verified memory readback](judging-memory-readback-2026-11-05.md)
