import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadCurrentApprovedLessons } from "../../packages/db/src/approved-lessons";
import { updateReviewedLesson } from "../../packages/db/src/lessons";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  assertJourneyDatabase,
  executeApplicationJourney,
  initializeJourneyStore,
  journeyHash,
  journeyDecisionHash,
  resolveJourneyHumanBinding,
  type ApplicationJourneyFixture,
  type JourneyBindings,
} from "../../packages/agent/src/application-journey";
const url = process.env.JOURNEY_EVAL_DATABASE_URL;
describe.skipIf(!url)(
  "actual application journey checkpoint and human boundary",
  () => {
    const pool = new Pool({ connectionString: url, max: 3 });
    const runId = `eval:${randomUUID()}`;
    const fixture: ApplicationJourneyFixture = {
      id: "db-boundary",
      ownerId: "abstract-owner",
      namespace: "eval:journeys",
      eventId: "game",
      now: "2026-11-01T00:00:00Z",
      steps: [
        {
          id: "session",
          actor: "agent",
          action: {
            type: "new_session",
            sessionId: "abstract-session",
            eventId: "game",
            at: "2026-11-01T00:00:00Z",
          },
          violations: [],
        },
        {
          id: "consent",
          actor: "synthetic_user",
          action: {
            type: "consent",
            enabled: true,
            reviewer: "synthetic_user",
          },
          violations: [],
        },
        {
          id: "research",
          actor: "agent",
          action: {
            type: "propose",
            proposalId: "proposal",
            eventId: "game",
            evidenceIds: ["source"],
          },
          violations: [],
        },
      ],
    };
    // Real runtime with deterministic provider, explicitly separate from live model evidence.
    const bindings: JourneyBindings = {
      research: {
        research: {
          message: "Explain only the supplied source. Do not draft any pick.",
          market: {
            platform: "kalshi",
            nativeId: "EVAL-JOURNEY",
            question: "Evaluation question",
            outcomes: ["Yes", "No"],
            rules: null,
          },
          marketSource: {
            id: "source",
            text: "Explicit synthetic application evaluation evidence.",
            retrievedAt: fixture.now,
            url: "https://example.invalid/fixture",
          },
        },
      },
    };
    let calls = 0;
    const base = {
      pool,
      runId,
      fixture,
      bindings,
      maxCalls: 4,
      plan: async () => {
        calls++;
        return { tools: [] };
      },
      generate: async () => {
        calls++;
        return {
          message: "Evidence is insufficient.",
          evidenceRefs: ["source"],
          lessonRefs: [],
          proposedChange: null,
        };
      },
    };
    beforeAll(async () => {
      assertJourneyDatabase(url!, process.env.DATABASE_URL);
      await initializeJourneyStore(pool);
    });
    afterAll(async () => {
      const rows = (
        await pool.query(
          "SELECT checkpoint FROM journey_evaluation_checkpoints WHERE run_id=$1",
          [runId],
        )
      ).rows;
      for (const row of rows)
        await pool.query("DELETE FROM users WHERE id=$1", [
          row.checkpoint.ownerId,
        ]);
      await pool.query(
        "DELETE FROM journey_evaluation_checkpoints WHERE run_id=$1",
        [runId],
      );
      await pool.end();
    });
    it("stops at missing human choice, resumes the same session once, and retains application failure", async () => {
      const first = await executeApplicationJourney({ ...base, decisions: [] });
      expect(first.status).toBe("awaiting_user");
      expect(calls).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT memory_consent FROM conversations WHERE id=$1",
            [first.state.sessionId],
          )
        ).rows[0].memory_consent,
      ).toBe(false);
      const decisions = [
        {
          stepId: "consent",
          actionHash: journeyHash([
            runId,
            fixture.id,
            fixture.steps[1]!.action,
            null,
          ]),
          actor: "human" as const,
          decisionId: "explicit-test-human-fixture",
          suppliedAt: new Date().toISOString(),
        },
      ];
      const resumed = await executeApplicationJourney({ ...base, decisions });
      expect(resumed.state.sessionId).toBe(first.state.sessionId);
      expect(resumed.status).toBe("failed");
      expect(resumed.state.traces.at(-1)?.diagnostic).toBe(
        "UNGROUNDED_OR_WRONG_EVENT_PROPOSAL",
      );
      expect(
        (
          await pool.query(
            "SELECT memory_consent FROM conversations WHERE id=$1",
            [first.state.sessionId],
          )
        ).rows[0].memory_consent,
      ).toBe(true);
      const replay = await executeApplicationJourney({ ...base, decisions });
      expect(replay.state.traces).toEqual(resumed.state.traces);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM conversations WHERE user_id=$1",
            [first.state.ownerId],
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it("applies a newly supplied initial-consent decision when resuming an existing checkpoint", async () => {
      const current = {
        ...structuredClone(fixture),
        id: "late-initial-consent",
      };
      const first = await executeApplicationJourney({
        ...base,
        fixture: current,
        decisions: [],
      });
      expect(first.state.consent).toBe(false);
      const decision = {
        stepId: `${current.id}:initial-consent`,
        actionHash: journeyHash([
          runId,
          { fixtureId: current.id, enabled: true },
        ]),
        actor: "human" as const,
        decisionId: "synthetic-resume-setup-decision",
        suppliedAt: new Date().toISOString(),
      };
      const resumed = await executeApplicationJourney({
        ...base,
        fixture: current,
        decisions: [decision],
      });
      expect(resumed.state.consent).toBe(true);
      expect(resumed.state.sessionId).toBe(first.state.sessionId);
      expect(
        (
          await pool.query(
            "SELECT memory_consent FROM conversations WHERE id=$1",
            [first.state.sessionId],
          )
        ).rows[0].memory_consent,
      ).toBe(true);
    });
    it("waits for initial consent before memory operations and resumes the pending operation after setup", async () => {
      const current: ApplicationJourneyFixture = {
        ...structuredClone(fixture),
        id: "pending-memory-setup",
        steps: [
          fixture.steps[0]!,
          {
            id: "recall",
            actor: "agent",
            action: {
              type: "recall",
              lessonId: "missing",
              walrusAvailable: true,
            },
            violations: [],
          },
        ],
      };
      const options = {
        ...base,
        fixture: current,
        bindings: { recall: { research: bindings.research!.research! } },
        recall: async () => [],
      };
      const first = await executeApplicationJourney({
        ...options,
        decisions: [],
      });
      expect(first.status).toBe("awaiting_user");
      expect(first.state.traces.at(-1)?.result).toEqual({
        requiredDecisionStepId: `${current.id}:initial-consent`,
      });
      const decision = {
        stepId: `${current.id}:initial-consent`,
        actionHash: journeyHash([
          runId,
          { fixtureId: current.id, enabled: true },
        ]),
        actor: "human" as const,
        decisionId: "synthetic-initial-setup",
        suppliedAt: new Date().toISOString(),
      };
      const resumed = await executeApplicationJourney({
        ...options,
        decisions: [decision],
      });
      expect(resumed.state.traces.at(-1)?.diagnostic).toBe(
        "REQUESTED_LESSON_NOT_CURRENT_APPROVED",
      );
      expect(resumed.state.consent).toBe(true);
    });
    it.each(["marketSource", "independent"])(
      "rejects direct future %s evidence before any model call or agent run",
      async (sourceType) => {
        const current = {
          ...structuredClone(fixture),
          id: `future-source-${sourceType}`,
          steps: [
            fixture.steps[0]!,
            {
              id: "source",
              actor: "agent",
              action: {
                type: "read_snapshot" as const,
                evidenceId: "source",
                availableAt: fixture.now,
                status: "completed" as const,
              },
              violations: [],
            },
            fixture.steps[2]!,
          ],
        };
        const bound = structuredClone(bindings);
        bound.source = {
          source: { ...bindings.research!.research!.marketSource },
        };
        if (sourceType === "marketSource")
          bound.research!.research!.marketSource.retrievedAt =
            "2026-11-02T00:00:00Z";
        else
          bound.research!.research!.independent = [
            {
              ...bindings.research!.research!.marketSource,
              id: "independent",
              retrievedAt: "2026-11-02T00:00:00Z",
            },
          ];
        const prior = calls;
        const result = await executeApplicationJourney({
          ...base,
          fixture: current,
          bindings: bound,
          decisions: [],
        });
        expect(result.state.traces.at(-1)?.diagnostic).toBe("FUTURE_EVIDENCE");
        expect(calls).toBe(prior);
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM agent_runs WHERE user_id=$1",
              [result.state.ownerId],
            )
          ).rows[0].n,
        ).toBe(0);
      },
    );
    it("rejects result evidence after the journey clock even before wall-clock result ingestion", async () => {
      const current = {
        ...structuredClone(fixture),
        id: "future-result",
        steps: [
          fixture.steps[0]!,
          {
            id: "result",
            actor: "agent",
            action: {
              type: "observe_result" as const,
              resultId: "r",
              version: 1,
              availableAt: "2026-11-02T00:00:00Z",
            },
            violations: [],
          },
        ],
      };
      const result = await executeApplicationJourney({
        ...base,
        fixture: current,
        bindings: {
          result: {
            settlement: {
              status: "final",
              winner: "Yes",
              rulesHash: "fixture",
              sourceUrl: "https://kalshi.com/fixture",
              retrievedAt: "2026-11-02T00:00:00Z",
            },
          },
        },
        decisions: [],
      });
      expect(result.state.traces.at(-1)?.diagnostic).toBe("FUTURE_RESULT");
    });
    it("executes the real read-only runtime, persists results and history and restores without duplicate model calls", async () => {
      const current = structuredClone(fixture);
      current.id = "runtime";
      current.steps.splice(2, 0, {
        id: "source",
        actor: "agent",
        action: {
          type: "read_snapshot",
          evidenceId: "source",
          availableAt: fixture.now,
          status: "completed",
        },
        violations: [],
      });
      const bound = {
        ...bindings,
        source: { source: bindings.research!.research!.marketSource },
      };
      const decisions = [
        {
          stepId: "consent",
          actionHash: journeyHash([
            runId,
            current.id,
            current.steps[1]!.action,
            null,
          ]),
          actor: "human" as const,
          decisionId: "synthetic-integration-decision-not-owner-evidence",
          suppliedAt: new Date().toISOString(),
        },
      ];
      const result = await executeApplicationJourney({
        ...base,
        fixture: current,
        bindings: bound,
        decisions,
      });
      expect(result.status, JSON.stringify(result.state.traces.at(-1))).toBe(
        "completed",
      );
      expect(calls).toBe(2);
      expect(
        (
          await pool.query(
            "SELECT status,result FROM agent_runs WHERE user_id=$1",
            [result.state.ownerId],
          )
        ).rows[0],
      ).toMatchObject({
        status: "completed",
        result: { reply: { message: "Evidence is insufficient." } },
      });
      const restored = await executeApplicationJourney({
        ...base,
        fixture: current,
        bindings: bound,
        decisions,
      });
      expect(restored.state.traces).toEqual(result.state.traces);
      expect(calls).toBe(2);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM picks WHERE user_id=$1",
            [result.state.ownerId],
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it("rejects generic reference approvals and prevents confirmation into another market", async () => {
      const original: ApplicationJourneyFixture = readFileSync(
        "tests/fixtures/agent-journeys/cases.jsonl",
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((c) => c.id === "correct_lesson");
      const current = {
        ...original,
        id: "wrong-market-confirm",
        steps: original.steps.slice(0, 4),
      };
      const bound: JourneyBindings = JSON.parse(
        readFileSync(
          "tests/fixtures/agent-journeys/application-bindings.json",
          "utf8",
        ),
      ).correct_lesson;
      const step = current.steps.at(-1)!;
      bound[step.id]!.pick!.nativeId = "OTHER-EVALUATION-MARKET";
      bound[step.id]!.pick!.snapshot.nativeId = "OTHER-EVALUATION-MARKET";
      const options = {
        ...base,
        fixture: current,
        bindings: bound,
        plan: async () => ({ tools: [] }),
        generate: async () => ({
          message: "Synthetic response",
          evidenceRefs: [],
          lessonRefs: [],
          proposedChange: null,
          proposedPick: {
            outcome: "Yes",
            reason: "Explicit synthetic evaluation choice.",
          },
        }),
      };
      const first = await executeApplicationJourney({
        ...options,
        decisions: [],
      });
      expect(first.status).toBe("awaiting_user");
      const generic = {
        stepId: step.id,
        actionHash: journeyHash([
          runId,
          current.id,
          step.action,
          bound[step.id],
        ]),
        actor: "human" as const,
        decisionId: "synthetic-generic-decision",
        suppliedAt: new Date().toISOString(),
      };
      const denied = await executeApplicationJourney({
        ...options,
        decisions: [generic],
      });
      expect(denied.status).toBe("awaiting_user");
      const concrete = {
        ...generic,
        actionHash: journeyDecisionHash(
          runId,
          current.id,
          step.action,
          bound[step.id],
          first.state.refs,
        ),
        decisionId: "synthetic-concrete-decision",
      };
      const rejected = await executeApplicationJourney({
        ...options,
        decisions: [concrete],
      });
      expect(rejected.state.traces.at(-1)?.diagnostic).toBe(
        "EXACT_RUNTIME_PROPOSAL_MARKET_REQUIRED",
      );
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM picks WHERE user_id=$1",
            [first.state.ownerId],
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it.each([
      "correct_lesson",
      "paused_lesson",
      "rejected_lesson",
      "missing_lesson",
      "stale_readback",
      "unrelated_readback",
      "verified_lesson",
      "callback_pauses",
      "planner_pauses",
      "presigned_review",
    ])(
      "does not complete requested recall for %s with empty or invalid authority",
      async (caseId) => {
        const originalId =
          caseId === "paused_lesson" ? caseId : "correct_lesson";
        // Shift synthetic fixture timestamps into the past; DB wall-clock validation remains enabled.
        const past = <T>(value: T): T =>
          JSON.parse(
            JSON.stringify(value).replace(/2026-\d\d-\d\dT[0-9:.]+Z/g, (iso) =>
              new Date(Date.parse(iso) - 48 * 3600000).toISOString(),
            ),
          );
        const current: ApplicationJourneyFixture = past(
          readFileSync("tests/fixtures/agent-journeys/cases.jsonl", "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .find((c) => c.id === originalId),
        );
        const bound: JourneyBindings = past(
          JSON.parse(
            readFileSync(
              "tests/fixtures/agent-journeys/application-bindings.json",
              "utf8",
            ),
          )[originalId],
        );
        current.id = caseId;
        if (caseId === "missing_lesson")
          current.steps = current.steps.filter(
            (s) =>
              s.action.type !== "propose_lesson" &&
              s.action.type !== "user_review",
          );
        if (caseId === "rejected_lesson") {
          const review = current.steps.find(
            (s) => s.action.type === "user_review",
          )!;
          if (review.action.type === "user_review")
            review.action.decision = "reject";
          bound[review.id] = { review: { action: "reject", baseVersion: 1 } };
        }
        const decisions = [
          {
            stepId: `${caseId}:initial-consent`,
            actionHash: journeyHash([
              runId,
              { fixtureId: caseId, enabled: true },
            ]),
            actor: "human" as const,
            decisionId: "explicitly-synthetic-setup-decision",
            suppliedAt: new Date().toISOString(),
          },
        ];
        if (caseId === "presigned_review") {
          const review = current.steps.find(
            (s) => s.action.type === "user_review",
          )!;
          decisions.push({
            stepId: review.id,
            actionHash: journeyDecisionHash(
              runId,
              caseId,
              review.action,
              bound[review.id],
              {},
            ),
            actor: "human",
            decisionId: "synthetic-invalid-presigned-review",
            suppliedAt: new Date().toISOString(),
          });
        }
        let recallOwner = "";
        const options = {
          ...base,
          fixture: current,
          bindings: bound,
          decisions,
          maxCalls: 8,
          plan: async () => {
            if (caseId === "planner_pauses" && recallOwner) {
              const lessons = await loadCurrentApprovedLessons(
                pool,
                recallOwner,
              );
              if (lessons[0])
                await updateReviewedLesson(pool, recallOwner, lessons[0].id, {
                  requestId: randomUUID(),
                  baseVersion: lessons[0].version,
                  confirmed: true,
                  action: "paused",
                });
            }
            return { tools: [] };
          },
          generate: async (request: { prompt: string }) => ({
            message: "Synthetic proposed choice for integration only.",
            evidenceRefs: [],
            lessonRefs: [],
            proposedChange: null,
            proposedPick: /draft a new Yes pick/.test(
              JSON.parse(request.prompt).userMessage,
            )
              ? {
                  outcome: "Yes",
                  reason: "Explicit synthetic evaluation choice.",
                }
              : null,
          }),
          recall: async (ownerId: string) => {
            recallOwner = ownerId;
            const current = await loadCurrentApprovedLessons(pool, ownerId);
            if (caseId === "callback_pauses" && current[0]) {
              await updateReviewedLesson(pool, ownerId, current[0].id, {
                requestId: randomUUID(),
                baseVersion: current[0].version,
                confirmed: true,
                action: "paused",
              });
              return current;
            }
            if (caseId === "planner_pauses") return current;
            if (caseId === "verified_lesson") return current;
            if (caseId === "stale_readback")
              return current.map((l) => ({ ...l, version: l.version + 1 }));
            if (caseId === "unrelated_readback")
              return current.map((l) => ({ ...l, id: randomUUID() }));
            return [];
          },
        };
        let result = await executeApplicationJourney(options);
        for (let i = 0; i < 8 && result.status === "awaiting_user"; i++) {
          const step = current.steps.find(
            (s) => s.id === result.state.traces.at(-1)!.stepId,
          )!;
          if (
            caseId === "presigned_review" &&
            step.action.type === "user_review"
          )
            break;
          decisions.push({
            stepId: step.id,
            actionHash: journeyHash([
              runId,
              caseId,
              step.action,
              await resolveJourneyHumanBinding(
                pool,
                result.state.ownerId,
                current,
                step.action,
                bound[step.id],
                result.state.refs,
              ),
            ]),
            actor: "human",
            decisionId: "explicitly-synthetic-scripted-decision",
            suppliedAt: new Date().toISOString(),
          });
          result = await executeApplicationJourney(options);
        }
        if (caseId === "presigned_review") {
          expect(result.status).toBe("awaiting_user");
          expect(result.state.traces.at(-1)?.action.type).toBe("user_review");
          return;
        }
        expect(
          result.state.traces.at(-1)?.action.type,
          JSON.stringify(result.state.traces.at(-1)),
        ).toBe("recall");
        if (caseId === "verified_lesson") {
          expect(
            result.status,
            JSON.stringify(result.state.traces.at(-1)),
          ).toBe("completed");
          return;
        }
        expect(result.status).toBe("failed");
        expect(result.state.traces.at(-1)?.diagnostic).toBe(
          ["callback_pauses", "planner_pauses"].includes(caseId)
            ? "REQUESTED_LESSON_AUTHORITY_CHANGED"
            : [
                  "correct_lesson",
                  "stale_readback",
                  "unrelated_readback",
                ].includes(caseId)
              ? "REQUESTED_APPROVED_LESSON_NOT_RECALLED"
              : "REQUESTED_LESSON_NOT_CURRENT_APPROVED",
        );
      },
    );
  },
);
