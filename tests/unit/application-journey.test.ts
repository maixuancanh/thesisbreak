import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  assertJourneyDatabase,
  humanDecision,
  journeyHash,
  resolveJourneyRefs,
  assertJourneySourceTimes,
  assertJourneyProposalMarket,
  journeyDecisionHash,
} from "../../packages/agent/src/application-journey";

describe("application journey boundaries", () => {
  it("human decisions cover concrete resolved payloads and reject unresolved reference hashes", () => {
    const action = { type: "user_confirm", proposalId: "p" };
    const binding = { outcome: "$ref:proposal.outcome" };
    const refs = { proposal: { outcome: "Yes" } };
    const actual = journeyDecisionHash(
      "eval:run",
      "case",
      action,
      binding,
      refs,
    );
    const generic = journeyHash(["eval:run", "case", action, binding]);
    expect(actual).not.toBe(generic);
    const oldDecision = {
      stepId: "confirm",
      actionHash: generic,
      actor: "human" as const,
      decisionId: "test",
      suppliedAt: "2026-11-01T00:00:00Z",
    };
    expect(
      humanDecision([oldDecision], "confirm", [
        "eval:run",
        "case",
        action,
        resolveJourneyRefs(binding, refs),
      ]),
    ).toBeNull();
    expect(actual).not.toBe(
      journeyDecisionHash("eval:run", "case", action, binding, {
        proposal: { outcome: "No" },
      }),
    );
  });
  it("rejects future or invalid source timestamps before runtime dispatch", () => {
    const now = "2026-11-01T00:00:00Z";
    const source = {
      id: "s",
      text: "fixture",
      url: "https://example.invalid",
      retrievedAt: now,
    };
    expect(() => assertJourneySourceTimes(now, [source])).not.toThrow();
    for (const modified of [
      { ...source, retrievedAt: "2026-11-02T00:00:00Z" },
      { ...source, publishedAt: "2026-11-02T00:00:00Z" },
      { ...source, retrievedAt: "invalid" },
    ])
      expect(() => assertJourneySourceTimes(now, [modified])).toThrow();
  });
  it("confirmation binds runtime platform, native market and event as well as outcome/reason", () => {
    const market = { platform: "kalshi", nativeId: "A", eventId: "event-A" };
    const pick = { ...market, snapshot: { ...market } };
    expect(() =>
      assertJourneyProposalMarket(market, pick, "event-A"),
    ).not.toThrow();
    expect(() =>
      assertJourneyProposalMarket(
        market,
        { ...pick, nativeId: "B", snapshot: { ...market, nativeId: "B" } },
        "event-A",
      ),
    ).toThrow();
    expect(() =>
      assertJourneyProposalMarket(
        market,
        { ...pick, platform: "polymarket" },
        "event-A",
      ),
    ).toThrow();
    expect(() =>
      assertJourneyProposalMarket(
        market,
        { ...pick, snapshot: { ...market, eventId: "other-event" } },
        "event-A",
      ),
    ).toThrow();
    expect(() =>
      assertJourneyProposalMarket(market, pick, "later-event"),
    ).toThrow();
  });
  it("ships explicit synthetic payload bindings for all twelve corpus cases without human decisions", () => {
    const cases = readFileSync(
      "tests/fixtures/agent-journeys/cases.jsonl",
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const pack = JSON.parse(
      readFileSync(
        "tests/fixtures/agent-journeys/application-bindings.json",
        "utf8",
      ),
    );
    expect(Object.keys(pack)).toHaveLength(12);
    for (const fixture of cases)
      for (const step of fixture.steps) {
        const field = (
          {
            read_snapshot: "source",
            propose: "research",
            recall: "research",
            user_confirm: "pick",
            observe_result: "settlement",
            propose_lesson: "candidate",
            user_review: "review",
          } as Record<string, string>
        )[step.action.type];
        if (field)
          expect(
            pack[fixture.id][step.id]?.[field],
            `${fixture.id}/${step.id}`,
          ).toBeDefined();
      }
    expect(JSON.stringify(pack)).not.toContain('"actor":"human"');
  });
  it("only accepts a dedicated local evaluation database, including encoded names", () => {
    expect(() =>
      assertJourneyDatabase(
        "postgres://u:p@localhost/thesisbreak_journey_eval",
        undefined,
      ),
    ).not.toThrow();
    for (const url of [
      "postgres://u:p@remote/thesisbreak_journey_eval",
      "postgres://u:p@localhost/production",
      "postgres://u:p@localhost/thesisbreak%5fprod",
      "postgres://u:p@localhost/thesisbreak_journey_eval?host=remote",
    ]) {
      expect(() => assertJourneyDatabase(url, undefined)).toThrow();
    }
    expect(() =>
      assertJourneyDatabase(
        "postgres://u:p@localhost/thesisbreak_journey_eval",
        "postgres://u:p@localhost/thesisbreak_journey_eval",
      ),
    ).toThrow();
  });
  it("synthetic reviewers never count as supplied human decisions and binds decisions to exact payload", () => {
    const action = {
      type: "user_confirm",
      proposalId: "p",
      reviewer: "synthetic_user",
    };
    expect(humanDecision([], "s", action)).toBeNull();
    const decision = {
      stepId: "s",
      actionHash: journeyHash(action),
      actor: "human" as const,
      decisionId: "review-1",
      suppliedAt: "2026-11-03T00:00:00Z",
    };
    expect(humanDecision([decision], "s", action)).toEqual(decision);
    expect(
      humanDecision([decision], "s", { ...action, proposalId: "other" }),
    ).toBeNull();
  });
  it("resolves exact references and fails closed on missing resource versions", () => {
    expect(
      resolveJourneyRefs(
        { id: "$ref:s.id", version: 2 },
        { s: { id: "uuid" } },
      ),
    ).toEqual({ id: "uuid", version: 2 });
    expect(() =>
      resolveJourneyRefs("$ref:s.version", { s: { id: "uuid" } }),
    ).toThrow("MISSING_JOURNEY_REFERENCE");
  });
});
