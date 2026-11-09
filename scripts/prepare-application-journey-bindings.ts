/** Deterministic synthetic payload pack. Produces no human decisions. No database/network access. */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type {
  ApplicationJourneyFixture,
  JourneyBindings,
} from "../packages/agent/src/application-journey";
import { journeyHash } from "../packages/agent/src/application-journey";
const output = process.argv.find((a) => a.startsWith("--output="))?.slice(9);
if (!output) throw Error("NEW_OUTPUT_FILE_REQUIRED");
const uuid = (value: string) => {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const cases: ApplicationJourneyFixture[] = (
  await readFile("tests/fixtures/agent-journeys/cases.jsonl", "utf8")
)
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const pack: Record<string, JourneyBindings> = {};
for (const c of cases) {
  const bindings: JourneyBindings = {};
  const proposal = c.steps.find((s) => s.action.type === "propose")!;
  const message =
    "Explicit synthetic evaluation: draft a new Yes pick with reason 'Explicit synthetic evaluation choice.'. Require an official lineup before changing an event. This is not a live market or actual user investment instruction.";
  const market = {
    platform: "kalshi" as const,
    nativeId: `EVAL-${c.id.toUpperCase().replaceAll("_", "-")}`,
    question: `Synthetic journey ${c.id}; no real event.`,
    outcomes: ["Yes", "No"],
    rules: "Explicit synthetic evaluation fixture only.",
  };
  let now = c.now;
  let currentCandidate = "";
  let candidateVersion = 1;
  let approvedReview = "";
  for (const s of c.steps) {
    const action = s.action;
    if (action.type === "new_session") {
      now = action.at;
      continue;
    }
    const source = {
      id: "synthetic-official-lineup",
      text: "Synthetic fixture: an explicit official lineup is present. This is not real reporting.",
      retrievedAt: now,
      url: "https://example.invalid/synthetic-journey",
      kind: "official_event" as const,
      confirmsLineup: true,
    };
    if (action.type === "read_snapshot")
      bindings[s.id] = {
        source: { ...source, retrievedAt: action.availableAt },
      };
    if (action.type === "propose" || action.type === "recall")
      bindings[s.id] = {
        research: {
          message:
            action.type === "propose"
              ? message
              : "Synthetic recall check: explain which approved prior procedure applies. Do not draft or change a pick.",
          market,
          marketSource: { ...source, id: "synthetic-market", kind: "market" },
          independent: [source],
        },
      };
    if (action.type === "user_confirm")
      bindings[s.id] = {
        pick: {
          platform: market.platform,
          nativeId: market.nativeId,
          outcome: `$ref:${proposal.id}.reply.proposedPick.outcome`,
          reason: `$ref:${proposal.id}.reply.proposedPick.reason`,
          snapshot: {
            platform: market.platform,
            nativeId: market.nativeId,
            eventId: c.eventId,
            question: market.question,
            outcomes: [
              { name: "Yes", price: null },
              { name: "No", price: null },
            ],
            rulesReference: "https://example.invalid/synthetic-rules",
            rulesHash: journeyHash("synthetic-journey-rules"),
            closeTime: null,
            fetchedAt: now,
            priceAsOf: null,
            nativeUnit: "synthetic",
            raw: { synthetic: true, fixtureId: c.id },
          },
        },
      };
    if (action.type === "observe_result")
      bindings[s.id] = {
        settlement: {
          winner: action.version % 2 ? "Yes" : "No",
          status: "final",
          rulesHash: journeyHash("synthetic-journey-rules"),
          sourceUrl:
            "https://kalshi.com/synthetic-evaluation-fixture-not-a-real-event",
          retrievedAt: action.availableAt,
        },
      };
    if (action.type === "propose_lesson") {
      currentCandidate = s.id;
      const atomId = uuid(`${c.id}:atom`);
      const digest = createHash("sha256").update(message).digest("hex");
      const researchTime = c.steps.find(
        (x) => x.action.type === "read_snapshot",
      )!.action;
      const retrievedAt =
        researchTime.type === "read_snapshot"
          ? researchTime.availableAt
          : c.now;
      bindings[s.id] = {
        experience: {
          requestId: uuid(`${c.id}:experience`),
          runId: `$ref:${proposal.id}.runId`,
          sessionId: `$ref:${proposal.id}.sessionId`,
          eventId: c.eventId,
          modelVersion: "synthetic-journey-binding-v1",
          promptVersion: "synthetic-journey-v1",
          prerequisites: [],
          outcome: null,
          atoms: [
            {
              id: atomId,
              origin: "user_statement",
              reference: `$ref:${proposal.id}.messageReference`,
              version: 1,
              hash: digest,
              text: message,
              eventId: c.eventId,
              publishedAt: null,
              occurredAt: null,
              retrievedAt,
              sourceOrigin: `$ref:${proposal.id}.ownerSourceOrigin`,
            },
          ],
        },
        candidate: {
          requestId: uuid(`${c.id}:candidate`),
          kind: "research_procedure",
          scope: { domain: "Sports", eventId: c.eventId },
          statement:
            "Synthetic evaluation preference: require official lineup before changing this event.",
          experienceIds: [`$ref:experience:${s.id}.id`],
          evidence: [
            {
              atomId,
              version: 1,
              hash: digest,
              stance: "support",
              quote: message,
            },
          ],
          modelVersion: "synthetic-journey-binding-v1",
          promptVersion: "synthetic-journey-v1",
          condition: {
            type: "require_official_lineup",
            expiresAt: "2099-01-01T00:00:00Z",
          },
        },
      };
    }
    if (action.type === "user_review") {
      if (["approve", "reject", "edit"].includes(action.decision)) {
        bindings[s.id] = {
          review: {
            action: action.decision,
            baseVersion: candidateVersion,
            ...(action.decision === "approve"
              ? { memoryConsent: true, acknowledgeConflict: true }
              : {}),
            ...(action.decision === "edit"
              ? {
                  statement:
                    "Edited synthetic preference: wait for the official lineup.",
                  scope: { domain: "Sports", eventId: c.eventId },
                  condition: {
                    type: "require_official_lineup",
                    expiresAt: "2099-01-01T00:00:00Z",
                  },
                }
              : {}),
          },
        };
        if (action.decision === "edit") candidateVersion++;
        if (action.decision === "approve") approvedReview = s.id;
      } else
        bindings[s.id] = {
          review: {
            lessonId: `$ref:${approvedReview}.lessonId`,
            candidateId: `$ref:${currentCandidate}.id`,
          },
        };
    }
  }
  pack[c.id] = bindings;
}
await writeFile(output, JSON.stringify(pack, null, 2) + "\n", { flag: "wx" });
console.log(
  JSON.stringify({
    cases: cases.length,
    dataMode: "synthetic",
    humanDecisions: 0,
    output,
  }),
);
