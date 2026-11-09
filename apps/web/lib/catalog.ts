export type Platform = "Polymarket" | "Kalshi";
export type Market = {
  id: string;
  platform: Platform;
  question: string;
  category: string;
  teams: [string, string];
  yes: number;
  time: string;
  rules: string;
};
const rows: [string, string, string, string, number][] = [
  [
    "harbor",
    "Harbor FC",
    "Milltown",
    "Will Harbor FC beat Milltown in regular time?",
    58,
  ],
  [
    "riverside",
    "Riverside",
    "Eastport",
    "Will Riverside beat Eastport in regular time?",
    63,
  ],
  [
    "northbridge",
    "Northbridge",
    "Eastford",
    "Will Northbridge vs Eastford finish with over 2.5 goals?",
    54,
  ],
  [
    "westport",
    "Westport",
    "Vale",
    "Will both Westport and Vale score in regular time?",
    61,
  ],
  [
    "kingsbay",
    "Kingsbay",
    "Dockland",
    "Will Kingsbay beat Dockland in regular time?",
    47,
  ],
  [
    "oakfield",
    "Oakfield",
    "Stonebridge",
    "Will Oakfield vs Stonebridge end in a draw?",
    27,
  ],
];
export const markets: Market[] = (["Polymarket", "Kalshi"] as const).flatMap(
  (platform) =>
    rows.map(([id, a, b, question, yes], i) => ({
      id,
      platform,
      question,
      category: "Football",
      teams: [a, b] as [string, string],
      yes: platform === "Kalshi" ? yes - 2 : yes,
      time: `Fictional fixture ${i + 1} · London`,
      rules: `Sample terms v1 (${platform}/${id}): Yes resolves only if the exact question is satisfied at the end of 90 minutes plus stoppage time. Extra time and penalties are excluded. Abandoned fixtures are void in this fictional preview. Sample settlement record: fictional league results. These are illustrative terms, not actual platform rules.`,
    })),
);
export const marketPath = (m: Market) =>
  `/market/${m.platform.toLowerCase()}/${m.id}`;
export const marketKey = (m: Market) => `${m.platform}:${m.id}:terms-v1`;
// Future server boundary; deliberately no endpoint or pretend provider implementation.
export interface ThesisGateway {
  send(input: {
    platform: Platform;
    marketId: string;
    termsVersion: string;
    threadId: string;
    text: string;
    idempotencyKey: string;
  }): Promise<{ text: string; sourceIds: string[] }>;
}
