import { expect, it } from "vitest";
import { presentReplyCitations } from "../../apps/web/lib/reply-citations";
it("numbers only exact known evidence references without rewriting prose or unknown refs", () => {
  const sources = [{ id: "news:nba:abc" }, { id: "market-source" }];
  expect(
    presentReplyCitations(
      "Status [news:nba:abc, market-source]. [independent-status] [unverified] [text]",
      sources,
    ),
  ).toBe("Status [1, 2]. [Source status] [unverified] [text]");
});
