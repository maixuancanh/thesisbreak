import { it, expect } from "vitest";
import {
  independentAgentSources,
  type NewsCheck,
} from "../../packages/integrations/src/news/collect";
const base: NewsCheck = {
  source: "balldontlie",
  state: "invalid",
  background: true,
  checkedAt: new Date().toISOString(),
  items: [
    {
      id: "x",
      url: "https://api.balldontlie.io/nba/v1/games",
      title: "Game",
      text: "Snapshot",
      publishedAt: null,
      retrievedAt: new Date().toISOString(),
      eventDate: null,
      teams: ["Los Angeles Lakers"],
    },
  ],
};
it("never supplies invalid provider rows as ordinary evidence", () => {
  expect(independentAgentSources([base])).toHaveLength(1);
  const output = independentAgentSources([{ ...base, state: "partial" }]);
  expect(output[1]?.text).toContain('"state":"partial"');
  expect(output[1]?.text).toContain('"background":true');
});
it("prioritizes the named player from the discussion over unrelated report rows", () => {
  const items = Array.from({ length: 8 }, (_, i) => ({
    ...base.items[0]!,
    id: String(i),
    player: i === 7 ? "James, LeBron" : `Other, Player${i}`,
  }));
  const output = independentAgentSources(
    [
      {
        ...base,
        state: "available",
        source: "nba-official",
        background: false,
        items,
      },
    ],
    "I expect LeBron James to play",
  );
  expect(output[1]?.text).toContain("James, LeBron");
});
