# NBA bookmaker odds and Polygon evidence

## Spurs vs. Trail Blazers

The production forecast ledger recorded a FanDuel moneyline baseline for Portland against San Antonio on November 7, 2026. The source observation time was 02:55:02 UTC on November 7 and the scheduled tipoff was 03:00 UTC on November 8. The recorded Portland probability was 40.70% after proportional removal of the bookmaker margin. The matching record identifies NBA game 0022600195. The bookmaker and official schedule timestamps differed by ten minutes. The recorded matching policy permits up to 15 minutes when the official game identity is present.

Polymarket lists a moneyline for the same teams and scheduled tipoff. Its published terms count overtime and specify a split resolution in certain cancellation, delay or abandonment cases. The bookmaker quote record does not establish the applicable FanDuel terms for those cases. [Polymarket event and rules](https://polymarket.com/sports/nba/nba-sas-por-2026-11-07)

**Comparison status: incomplete.** Tatum identified the Polymarket moneyline condition `0x4c724036f06d2eb9fc9e983a7637d1ad11fb9dd3687a3ec9f12178dd0e119d83`. A Tatum Polygon RPC check of finalized blocks 96,876,368–96,876,494 (02:53:28–02:56:37 UTC on November 7) returned zero matching `OrdersMatched` events for either outcome on the two Polymarket V2 exchanges. This sample covers the FanDuel observation time. It supplies no matched price for this comparison.

The [FanDuel Massachusetts rules](https://policies.fanduel.com/SB/MA/2026-07-30T12-48-41.html) are a review source. The odds observation identifies the US region, so it does not establish that Massachusetts rules applied. The reported price gap remains blank.

A separate sample near scheduled tipoff (November 8, 02:57:55–03:01:04 UTC, blocks 96,934,146–96,934,272) verified 20 matched orders through Tatum Polygon RPC. Six Spurs matches totaled 779.69 pUSD at a share-weighted average of 68.00¢. Fourteen Portland matches totaled 643.64 pUSD at 32.85¢. This sample demonstrates the transaction reader and falls outside the FanDuel observation window. [Example Portland transaction](https://polygonscan.com/tx/0xa862a3d24b91b3a991cc0c215cddf59f210cd669c3256e46eda845b2b7953fb1)

The check uses the original bookmaker observation and the outcome tokens for the reviewed Polymarket condition. It decodes finalized `OrdersMatched` logs and checks the observed time window. A reported gap also requires compatible settlement terms. [Polymarket exchange event ABI](https://github.com/Polymarket/ctf-exchange-v2/blob/main/src/exchange/interfaces/ITrading.sol)

## Time-aligned BetMGM observations

Two additional production baselines had finalized Polygon activity in the same time window. Each probability below removes the bookmaker margin proportionally. Polygon prices are averages weighted by shares in the sampled blocks.

| Home outcome                         | BetMGM observation (UTC) | BetMGM probability | Polygon window (UTC) | Matched orders | Polygon price | Example                                                                                                              |
| ------------------------------------ | ------------------------ | -----------------: | -------------------- | -------------: | ------------: | -------------------------------------------------------------------------------------------------------------------- |
| Minnesota Timberwolves vs. Utah Jazz | Nov 8, 22:58:28          |             82.58% | 22:56:54–23:00:03    |              3 |        84.00¢ | [Polygon transaction](https://polygonscan.com/tx/0xfd4242854e7641ef7ea1ab6afc35ceae6f29ec388f6297d9e25815b3bcdbdcb6) |
| Chicago Bulls vs. Philadelphia 76ers | Nov 8, 19:26:08          |             20.83% | 19:24:34–19:27:43    |              2 |        20.98¢ | [Polygon transaction](https://polygonscan.com/tx/0x404be6827e53a5a870daf77617d50b2cfe3eccd6f0bee6ce346969651f775eb4) |

The ledger identifies NBA games `0022600198` and `0022600196`. The Tatum Polygon samples covered blocks 96,982,105–96,982,231 and 96,973,612–96,973,738 respectively. The US-region feed does not identify which BetMGM jurisdiction governed either quote. The Massachusetts house rules illustrate why the source matters: they include a minimum game duration for official NBA results. The price-gap field stays blank while applicable settlement terms are unresolved. [BetMGM Massachusetts house rules](https://assets.contentstack.io/v3/assets/bltc6ce635bc4868eb2/bltf5b24edb8a728780/mgm-springfield-casino-betmgm-sport-waging-house-rules.pdf)
