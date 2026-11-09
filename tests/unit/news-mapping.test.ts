import { it, expect } from "vitest";
import {
  nbaTarget,
  selectEvidence,
  changedReasonFacts,
} from "../../packages/integrations/src/news/mapping";
it("maps only exact native NBA game/date and rejects ambiguous events", () => {
  expect(
    nbaTarget({
      platform: "kalshi",
      nativeId: "KXNBAGAME-26OCT25LALUTA-LAL",
      eventId: "KXNBAGAME-26OCT25LALUTA",
    }),
  ).toMatchObject({
    eventDate: "2026-10-25",
    teams: ["Los Angeles Lakers", "Utah Jazz"],
  });
  expect(
    nbaTarget({
      platform: "kalshi",
      nativeId: "KXNBAGAME-26FEB30LALUTA-LAL",
      eventId: "KXNBAGAME-26FEB30LALUTA",
    }),
  ).toBeNull();
  expect(
    nbaTarget({
      platform: "polymarket",
      nativeId: "KXNBAGAME-26OCT25LALUTA-LAL",
    }),
  ).toBeNull();
  expect(
    nbaTarget({
      platform: "kalshi",
      nativeId: "KXNBAGAME-26OCT25LALUTA-LAL",
      eventId: "OTHER",
    }),
  ).toBeNull();
});
const target = {
  eventDate: "2026-10-25",
  teams: ["Los Angeles Lakers", "Utah Jazz"],
};
const item = {
  id: "i",
  url: "https://nba.com/test",
  title: "Player status",
  text: "Source status",
  publishedAt: null,
  retrievedAt: "2026-10-25T10:00:00Z",
  eventDate: target.eventDate,
  teams: target.teams,
  player: "James, LeBron",
  status: "Questionable",
};
it("keeps exact date/team facts apart from background announcements", () => {
  expect(
    selectEvidence(
      [item, { ...item, id: "wrong", eventDate: "2026-10-24" }],
      target,
    ),
  ).toHaveLength(1);
  expect(selectEvidence([{ ...item, eventDate: null }], target)).toHaveLength(
    0,
  );
});
it("requires changed explicit status and a full player name in the saved reason", () => {
  const next = { ...item, status: "Out" };
  expect(
    changedReasonFacts([item], [next], "I expect LeBron James to play."),
  ).toHaveLength(1);
  expect(
    changedReasonFacts([item], [next], "I expect James to play."),
  ).toHaveLength(0);
  expect(changedReasonFacts([], [next], "LeBron James will play")).toHaveLength(
    0,
  );
  expect(
    changedReasonFacts(
      [item],
      [{ ...next, player: "Other, Player" }],
      "LeBron James will play",
    ),
  ).toHaveLength(0);
  expect(
    changedReasonFacts([item], [item], "LeBron James will play"),
  ).toHaveLength(0);
});
