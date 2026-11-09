import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { JourneyAction } from "../../domain/src/agent-journey";
import {
  createChatSession,
  chatHistory,
  setChatMemoryConsent,
} from "../../db/src/chat-sessions";
import { claimRun, finishRun } from "../../db/src/agent-runs";
import { createPick, readPicks, type Snapshot } from "../../db/src/picks";
import {
  recordActionSettlement,
  setActionMemoryConsent,
} from "../../db/src/action-history";
import {
  createLessonCandidate,
  recordLearningExperience,
  reviewLessonCandidate,
} from "../../db/src/experience-learning";
import { listLessons, updateReviewedLesson } from "../../db/src/lessons";
import { loadCurrentApprovedLessons } from "../../db/src/approved-lessons";
import { listLearningCandidates } from "../../db/src/experience-learning";
import { lessonVersionSchema } from "../../domain/src/lesson";
import {
  runResearch,
  type ReadPlan,
  type ResearchSource,
  recentHistory,
} from "./runtime";
import type { GenerateReply } from "./context";

export const journeyHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function assertKnownAt(
  now: string,
  times: (string | null | undefined)[],
  futureCode: string,
) {
  const cutoff = Date.parse(now);
  if (!Number.isFinite(cutoff)) throw Error("INVALID_JOURNEY_CLOCK");
  for (const value of times) {
    if (value == null) continue;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw Error("INVALID_EVIDENCE_TIME");
    if (time > cutoff) throw Error(futureCode);
  }
}
export function assertJourneySourceTimes(
  now: string,
  sources: ResearchSource[],
) {
  for (const source of sources)
    assertKnownAt(
      now,
      [
        source.retrievedAt,
        source.publishedAt,
        source.quoteObservedAt,
        source.historicalKnownAt,
      ],
      "FUTURE_EVIDENCE",
    );
}
type ProposalMarket = {
  platform: string;
  nativeId: string;
  eventId: string | null;
};
export function assertJourneyProposalMarket(
  proposed: ProposalMarket | undefined,
  pick: { platform: string; nativeId: string; snapshot: ProposalMarket },
  currentEvent: string,
) {
  if (
    !proposed ||
    proposed.platform !== pick.platform ||
    proposed.nativeId !== pick.nativeId ||
    proposed.eventId !== currentEvent ||
    pick.snapshot.platform !== proposed.platform ||
    pick.snapshot.nativeId !== proposed.nativeId ||
    pick.snapshot.eventId !== proposed.eventId
  )
    throw Error("EXACT_RUNTIME_PROPOSAL_MARKET_REQUIRED");
}
export function assertJourneyDatabase(
  raw: string,
  production: string | undefined,
) {
  const url = new URL(raw);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    decodeURIComponent(url.pathname) !== "/thesisbreak_journey_eval" ||
    url.search ||
    url.hash ||
    raw === production
  )
    throw Error("DEDICATED_LOCAL_JOURNEY_EVALUATION_DATABASE_REQUIRED");
  if (production) {
    const prod = new URL(production);
    if (
      ["localhost", "127.0.0.1", "[::1]"].includes(prod.hostname) &&
      (url.port || "5432") === (prod.port || "5432") &&
      decodeURIComponent(url.pathname) === decodeURIComponent(prod.pathname)
    )
      throw Error("PRODUCTION_DATABASE_FORBIDDEN");
  }
}
export type HumanDecision = {
  stepId: string;
  actionHash: string;
  actor: "human";
  decisionId: string;
  suppliedAt: string;
};
export function humanDecision(
  decisions: HumanDecision[],
  stepId: string,
  action: unknown,
) {
  return (
    decisions.find(
      (d) =>
        d.actor === "human" &&
        d.stepId === stepId &&
        d.actionHash === journeyHash(action) &&
        d.decisionId.trim() &&
        Number.isFinite(Date.parse(d.suppliedAt)),
    ) ?? null
  );
}
export function resolveJourneyRefs(
  value: unknown,
  refs: Record<string, unknown>,
): unknown {
  if (typeof value === "string" && value.startsWith("$ref:")) {
    const [key, ...path] = value.slice(5).split(".");
    let found: unknown = refs[key!];
    for (const part of path)
      found =
        found && typeof found === "object"
          ? (found as Record<string, unknown>)[part]
          : undefined;
    if (found === undefined) throw Error("MISSING_JOURNEY_REFERENCE");
    return structuredClone(found);
  }
  if (Array.isArray(value))
    return value.map((v) => resolveJourneyRefs(v, refs));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveJourneyRefs(v, refs)]),
    );
  return value;
}
export function journeyDecisionHash(
  runId: string,
  caseId: string,
  action: unknown,
  binding: unknown,
  refs: Record<string, unknown>,
) {
  return journeyHash([
    runId,
    caseId,
    action,
    resolveJourneyRefs(binding ?? null, refs),
  ]);
}
type ReviewAuthority = {
  candidate: {
    id: string;
    version: number;
    payloadHash: string;
    status: string;
  };
  lesson: { id: string; version: number; payloadHash: string } | null;
};
/** Review payloads are signable only after their exact owned application target exists. */
export async function resolveJourneyHumanBinding(
  pool: Pool,
  ownerId: string,
  fixture: ApplicationJourneyFixture,
  action: JourneyAction,
  binding: unknown,
  refs: Record<string, unknown>,
) {
  const resolved = resolveJourneyRefs(binding ?? null, refs) as
    (JourneyBindings[string] & { reviewAuthority?: ReviewAuthority }) | null;
  if (action.type !== "user_review") return resolved;
  if (!resolved?.review) throw Error("APPLICATION_REVIEW_REQUIRED");
  const original = fixture.steps.find(
    (s) =>
      s.action.type === "propose_lesson" &&
      s.action.lessonId === action.lessonId,
  );
  const candidateRef =
    original && (refs[original.id] as { id: string } | undefined);
  if (!candidateRef) throw Error("APPLICATION_CANDIDATE_REQUIRED");
  const candidates = await listLearningCandidates(pool, ownerId);
  const candidate = ["approve", "reject", "edit"].includes(action.decision)
    ? candidates.find(
        (c) =>
          c.id === candidateRef.id &&
          c.version === resolved.review!.baseVersion &&
          c.status === "pending_review",
      )
    : candidates.find(
        (c) =>
          c.id === candidateRef.id && c.lesson_id === resolved.review!.lessonId,
      );
  if (!candidate) throw Error("APPLICATION_REVIEW_TARGET_NOT_CURRENT");
  const lesson = candidate.lesson_id
    ? ((await listLessons(pool, ownerId)).find(
        (l) => l.lesson.id === candidate.lesson_id,
      )?.lesson ?? null)
    : null;
  if (
    ["pause", "revoke"].includes(action.decision) &&
    (!lesson || lesson.id !== resolved.review.lessonId)
  )
    throw Error("APPLICATION_LESSON_REQUIRED");
  return {
    ...resolved,
    reviewAuthority: {
      candidate: {
        id: candidate.id,
        version: candidate.version,
        payloadHash: journeyHash(candidate.payload),
        status: candidate.status,
      },
      lesson: lesson
        ? {
            id: lesson.id,
            version: lesson.version,
            payloadHash: journeyHash(lesson),
          }
        : null,
    } satisfies ReviewAuthority,
  };
}
export type ApplicationJourneyFixture = {
  id: string;
  ownerId: string;
  namespace: string;
  now: string;
  eventId: string;
  steps: {
    id: string;
    actor: string;
    action: JourneyAction;
    violations: string[];
  }[];
};
type ResearchBinding = {
  message: string;
  market: Parameters<typeof runResearch>[0]["market"];
  marketSource: ResearchSource;
  independent?: ResearchSource[];
};
/** Bindings supply evidence and actual application schema payloads absent from the abstract corpus.
 * Exact `$ref:stepId.field` values reference durable service results, never synthetic state. */
export type JourneyBindings = Record<
  string,
  {
    research?: ResearchBinding;
    source?: ResearchSource;
    pick?: {
      platform: string;
      nativeId: string;
      outcome: string;
      reason: string;
      snapshot: Snapshot;
    };
    experience?: unknown;
    candidate?: unknown;
    review?: Record<string, unknown>;
    settlement?: Parameters<typeof recordActionSettlement>[2];
  }
>;
type StepTrace = {
  stepId: string;
  action: JourneyAction;
  inputHash: string;
  status: "completed" | "failed" | "awaiting_user" | "awaiting_binding";
  result: unknown;
  diagnostic: string | null;
  humanDecision: HumanDecision | null;
  startedAt: string;
  latencyMs: number;
};
type Checkpoint = {
  ownerId: string;
  eventId: string;
  initialConsentDecision: HumanDecision | null;
  now: string;
  sessionId: string | null;
  consent: boolean;
  refs: Record<string, unknown>;
  evidence: Record<string, ResearchSource>;
  traces: StepTrace[];
  calls: number;
};

export async function initializeJourneyStore(pool: Pool) {
  const db = (await pool.query("SELECT current_database() AS name")).rows[0]
    ?.name;
  if (db !== "thesisbreak_journey_eval")
    throw Error("WRONG_EVALUATION_DATABASE");
  await pool.query(
    `CREATE TABLE IF NOT EXISTS journey_evaluation_checkpoints(run_id text NOT NULL,case_id text NOT NULL,fixture_hash text NOT NULL,checkpoint jsonb NOT NULL,PRIMARY KEY(run_id,case_id))`,
  );
}
export async function executeApplicationJourney(input: {
  pool: Pool;
  runId: string;
  fixture: ApplicationJourneyFixture;
  bindings: JourneyBindings;
  decisions: HumanDecision[];
  plan: ReadPlan;
  generate: GenerateReply;
  maxCalls: number;
  /** Optional read-only fresh remote recall. Must return only currently authorized readbacks. */
  recall?: (ownerId: string, query: string) => Promise<unknown[]>;
  onTrace?: (trace: StepTrace) => Promise<void>;
}) {
  const { pool, fixture: fixture, runId } = input;
  if (
    !/^eval:[a-zA-Z0-9_-]{1,100}$/.test(runId) ||
    !fixture.namespace.startsWith("eval:") ||
    fixture.steps.length > 100 ||
    !Number.isInteger(input.maxCalls) ||
    input.maxCalls < 1 ||
    input.maxCalls > 100
  )
    throw Error("INVALID_JOURNEY_BOUNDS");
  if (
    (await pool.query("SELECT current_database() AS name")).rows[0]?.name !==
    "thesisbreak_journey_eval"
  )
    throw Error("WRONG_EVALUATION_DATABASE");
  const lock = await pool.connect();
  const lockKey = JSON.stringify(["journey-eval", runId, fixture.id]);
  await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
    lockKey,
  ]);
  try {
    const stored = (
      await pool.query(
        "SELECT fixture_hash,checkpoint FROM journey_evaluation_checkpoints WHERE run_id=$1 AND case_id=$2",
        [runId, fixture.id],
      )
    ).rows[0];
    const fixtureHash = journeyHash(fixture);
    if (stored && stored.fixture_hash !== fixtureHash)
      throw Error("JOURNEY_CHECKPOINT_INPUT_MISMATCH");
    const state: Checkpoint = stored?.checkpoint ?? {
      ownerId: `eval-journey:${randomUUID()}`,
      eventId: fixture.eventId,
      initialConsentDecision: humanDecision(
        input.decisions,
        `${fixture.id}:initial-consent`,
        [runId, { fixtureId: fixture.id, enabled: true }],
      ),
      now: fixture.now,
      sessionId: null,
      consent: false,
      refs: {},
      evidence: {},
      traces: [],
      calls: 0,
    };
    assertKnownAt(state.now, [], "FUTURE_EVIDENCE");
    await pool.query(
      "INSERT INTO users(id,provider_subject) VALUES($1,$1) ON CONFLICT DO NOTHING",
      [state.ownerId],
    );
    const suppliedInitial = humanDecision(
      input.decisions,
      `${fixture.id}:initial-consent`,
      [runId, { fixtureId: fixture.id, enabled: true }],
    );
    if (
      (!stored && state.initialConsentDecision) ||
      (!state.initialConsentDecision && suppliedInitial)
    ) {
      if (
        state.traces.some(
          (t) => t.status === "completed" && t.action.type === "consent",
        )
      )
        throw Error("INITIAL_CONSENT_AFTER_EXPLICIT_CHOICE");
      state.initialConsentDecision = suppliedInitial;
      state.consent = true;
      await setActionMemoryConsent(pool, state.ownerId, true);
      if (state.sessionId)
        await setChatMemoryConsent(pool, state.ownerId, state.sessionId, true);
    }
    const persist = async () =>
      pool.query(
        "INSERT INTO journey_evaluation_checkpoints(run_id,case_id,fixture_hash,checkpoint) VALUES($1,$2,$3,$4) ON CONFLICT(run_id,case_id) DO UPDATE SET checkpoint=EXCLUDED.checkpoint",
        [runId, fixture.id, fixtureHash, JSON.stringify(state)],
      );
    await persist();
    for (const step of fixture.steps) {
      const binding = input.bindings[step.id];
      const inputHash = journeyHash([step.action, binding ?? null]);
      const previous = state.traces.findLast((t) => t.stepId === step.id);
      if (
        previous?.inputHash !== undefined &&
        previous.status !== "awaiting_binding" &&
        previous.inputHash !== inputHash
      )
        throw Error("JOURNEY_RETRY_PAYLOAD_MISMATCH");
      if (previous?.status === "completed") continue;
      if (previous?.status === "failed") break;
      const action = step.action;
      const requiresHuman = [
        "user_confirm",
        "user_reject",
        "user_review",
        "consent",
      ].includes(action.type);
      let resolvedHumanBinding: unknown;
      let missingHumanBinding = false;
      if (requiresHuman) {
        try {
          resolvedHumanBinding = await resolveJourneyHumanBinding(
            pool,
            state.ownerId,
            fixture,
            action,
            binding,
            state.refs,
          );
        } catch {
          missingHumanBinding = true;
        }
      }
      const decision =
        requiresHuman && !missingHumanBinding
          ? humanDecision(input.decisions, step.id, [
              runId,
              fixture.id,
              action,
              resolvedHumanBinding,
            ])
          : null;
      const started = Date.now();
      const trace: StepTrace = {
        stepId: step.id,
        action,
        inputHash,
        status: "completed",
        result: null,
        diagnostic: null,
        humanDecision: decision,
        startedAt: new Date().toISOString(),
        latencyMs: 0,
      };
      const requestId = () => {
        const key = `request:${step.id}`;
        return (state.refs[key] ??= randomUUID()) as string;
      };
      if (
        ["propose_lesson", "recall"].includes(action.type) &&
        !state.consent &&
        !state.initialConsentDecision &&
        !state.traces.some(
          (t) => t.status === "completed" && t.action.type === "consent",
        )
      ) {
        trace.status = "awaiting_user";
        trace.result = {
          requiredDecisionStepId: `${fixture.id}:initial-consent`,
        };
      } else if (missingHumanBinding) trace.status = "awaiting_binding";
      else if (requiresHuman && !decision) trace.status = "awaiting_user";
      else
        try {
          if (requiresHuman && step.actor !== "synthetic_user")
            throw Error("AGENT_CANNOT_APPROVE");
          requestId();
          await persist();
          const b = resolveJourneyRefs(
            action.type === "propose_lesson"
              ? { ...binding, candidate: null }
              : (binding ?? {}),
            state.refs,
          ) as NonNullable<typeof binding>;
          switch (action.type) {
            case "new_session":
              if (!Number.isFinite(Date.parse(action.at)))
                throw Error("INVALID_JOURNEY_CLOCK");
              if (Date.parse(action.at) < Date.parse(state.now))
                throw Error("TIME_REVERSAL");
              // Store intent before any API write; a crashed non-idempotent session creation is not replayed.
              if (
                state.refs[`session-intent:${step.id}`] &&
                !state.refs[step.id]
              )
                throw Error("SESSION_CREATION_REQUIRES_RECONCILIATION");
              state.refs[`session-intent:${step.id}`] = true;
              await persist();
              trace.result = await createChatSession(
                pool,
                state.ownerId,
                state.consent,
              );
              state.sessionId = (trace.result as { id: string }).id;
              state.now = action.at;
              state.eventId = action.eventId;
              break;
            case "read_snapshot":
              if (!b.source) {
                trace.status = "awaiting_binding";
                break;
              }
              if (action.status !== "completed")
                throw Error("SNAPSHOT_UNAVAILABLE");
              assertKnownAt(state.now, [action.availableAt], "FUTURE_EVIDENCE");
              assertJourneySourceTimes(state.now, [b.source]);
              state.evidence[action.evidenceId] = b.source;
              trace.result = {
                source: b.source,
                sourceHash: journeyHash(b.source),
              };
              break;
            case "propose":
            case "recall": {
              if (!b.research) {
                trace.status = "awaiting_binding";
                break;
              }
              if (!state.sessionId) throw Error("SESSION_REQUIRED");
              if (
                action.type === "propose" &&
                (action.eventId !== state.eventId ||
                  action.evidenceIds.some((id) => !state.evidence[id]) ||
                  !action.evidenceIds.length)
              )
                throw Error("UNGROUNDED_OR_WRONG_EVENT_PROPOSAL");
              if (action.type === "recall" && !state.consent)
                throw Error("MEMORY_CONSENT_REQUIRED");
              if (
                action.type === "recall" &&
                (!action.walrusAvailable || !input.recall)
              )
                throw Error("FRESH_WALRUS_RECALL_UNAVAILABLE");
              const r = b.research;
              assertJourneySourceTimes(state.now, [
                r.marketSource,
                ...(r.independent ?? Object.values(state.evidence)),
              ]);
              let recalledForStep: unknown[] | null = null;
              let requestedLesson: ReturnType<
                typeof lessonVersionSchema.parse
              > | null = null;
              const fenceReadbacks = async (values: unknown[]) => {
                const current = await loadCurrentApprovedLessons(
                  pool,
                  state.ownerId,
                );
                const accepted = values.filter((value) => {
                  const parsed = lessonVersionSchema.safeParse(value);
                  return (
                    parsed.success &&
                    current.some((l) => {
                      const live = lessonVersionSchema.parse(l);
                      return (
                        parsed.data.id === live.id &&
                        parsed.data.version === live.version &&
                        journeyHash(parsed.data) === journeyHash(live)
                      );
                    })
                  );
                });
                if (
                  requestedLesson &&
                  !accepted.some(
                    (value) =>
                      journeyHash(lessonVersionSchema.parse(value)) ===
                      journeyHash(requestedLesson),
                  )
                )
                  throw Error("REQUESTED_LESSON_AUTHORITY_CHANGED");
                return accepted;
              };
              if (action.type === "recall") {
                const original = fixture.steps.find(
                  (s) =>
                    s.action.type === "propose_lesson" &&
                    s.action.lessonId === action.lessonId,
                );
                const candidateRef =
                  original &&
                  (state.refs[original.id] as { id: string } | undefined);
                const candidates = await listLearningCandidates(
                  pool,
                  state.ownerId,
                );
                const candidate =
                  candidateRef &&
                  candidates.find(
                    (c) => c.id === candidateRef.id && c.status === "approved",
                  );
                const approved = await loadCurrentApprovedLessons(
                  pool,
                  state.ownerId,
                );
                const requested =
                  candidate &&
                  approved.find(
                    (l) =>
                      l.id === candidate.lesson_id &&
                      l.version === candidate.lesson_version,
                  );
                trace.result = {
                  recallCheck: {
                    requestedLessonId: action.lessonId,
                    candidateId: candidateRef?.id ?? null,
                    currentApprovedVersions: approved.map((l) => ({
                      id: l.id,
                      version: l.version,
                    })),
                  },
                };
                if (!requested)
                  throw Error("REQUESTED_LESSON_NOT_CURRENT_APPROVED");
                const recalled = await input.recall!(state.ownerId, r.message);
                const expected = lessonVersionSchema.parse(requested);
                requestedLesson = expected;
                recalledForStep = recalled.filter((value) => {
                  const parsed = lessonVersionSchema.safeParse(value);
                  return (
                    parsed.success &&
                    parsed.data.id === expected.id &&
                    parsed.data.version === expected.version &&
                    journeyHash(parsed.data) === journeyHash(expected)
                  );
                });
                trace.result = {
                  recallCheck: {
                    requestedLessonId: action.lessonId,
                    requestedVersion: expected,
                    freshReadbacks: recalled,
                    acceptedReadbacks: recalledForStep,
                  },
                };
                if (!recalledForStep.length)
                  throw Error("REQUESTED_APPROVED_LESSON_NOT_RECALLED");
                recalledForStep = await fenceReadbacks(recalledForStep);
              }
              const history = await chatHistory(
                pool,
                state.ownerId,
                state.sessionId,
              );
              const run = await claimRun(pool, state.ownerId, {
                platform: r.market.platform,
                nativeId: r.market.nativeId,
                provider: "public",
                message: r.message,
                requestId: requestId(),
                sessionId: state.sessionId,
              });
              if (!run.fresh) {
                if (run.status !== "completed")
                  throw Error("PREVIOUS_RUNTIME_ATTEMPT_INCOMPLETE");
                trace.result = {
                  runId: run.id,
                  ...run.result,
                  sessionId: state.sessionId,
                  messageReference: `${run.id}:message`,
                  ownerSourceOrigin: `user:${state.ownerId}`,
                  proposalMarket: {
                    platform: r.market.platform,
                    nativeId: r.market.nativeId,
                    eventId: state.eventId,
                  },
                };
                break;
              }
              const reserveCall = async () => {
                if (state.calls >= input.maxCalls)
                  throw Error("JOURNEY_MODEL_CALL_BUDGET_EXCEEDED");
                state.calls++;
                await persist();
              };
              try {
                const result = await runResearch(
                  {
                    userId: state.ownerId,
                    market: r.market,
                    message: r.message,
                    eventId: state.eventId,
                    history: recentHistory(
                      history
                        .filter((h) => h.status === "completed")
                        .flatMap((h) => [
                          { role: "user" as const, text: h.message },
                          {
                            role: "assistant" as const,
                            text: String(h.result?.reply?.message ?? ""),
                          },
                        ]),
                    ),
                    domain: "Sports",
                    now: new Date(state.now),
                  },
                  {
                    plan: async (request) => {
                      await reserveCall();
                      return input.plan(request);
                    },
                    generate: async (request) => {
                      await reserveCall();
                      return input.generate(request);
                    },
                    readPick: async () => {
                      const picks = await readPicks(pool, state.ownerId);
                      const pick = picks.find(
                        (p: { platform: string; native_id: string }) =>
                          p.platform === r.market.platform &&
                          p.native_id === r.market.nativeId,
                      );
                      return pick
                        ? {
                            userId: state.ownerId,
                            pickId: pick.id,
                            market: {
                              platform: r.market.platform,
                              nativeId: r.market.nativeId,
                            },
                            version: pick.current_version,
                            outcome: pick.outcome,
                            reason: pick.reason,
                          }
                        : null;
                    },
                    readLessons: async () =>
                      fenceReadbacks(
                        recalledForStep ??
                          (state.consent && input.recall
                            ? await input.recall(state.ownerId, r.message)
                            : []),
                      ),
                    readComparison: async () => [],
                    readIndependent: async () =>
                      (r.independent ?? Object.values(state.evidence)).filter(
                        (source) => source.id !== r.marketSource.id,
                      ),
                    marketSource: r.marketSource,
                  },
                );
                await finishRun(
                  pool,
                  state.ownerId,
                  run.id,
                  result,
                  "completed",
                );
                trace.result = { runId: run.id, ...result };
                trace.result = {
                  ...(trace.result as object),
                  sessionId: state.sessionId,
                  messageReference: `${run.id}:message`,
                  ownerSourceOrigin: `user:${state.ownerId}`,
                  proposalMarket: {
                    platform: r.market.platform,
                    nativeId: r.market.nativeId,
                    eventId: state.eventId,
                  },
                };
              } catch (error) {
                await finishRun(
                  pool,
                  state.ownerId,
                  run.id,
                  { error: "JOURNEY_RUNTIME_FAILED" },
                  "failed",
                );
                throw error;
              }
              break;
            }
            case "user_confirm": {
              if (!b.pick) {
                trace.status = "awaiting_binding";
                break;
              }
              const proposal = fixture.steps.find(
                (s) =>
                  s.action.type === "propose" &&
                  s.action.proposalId === action.proposalId,
              );
              const proposed =
                proposal &&
                (state.refs[proposal.id] as
                  | {
                      proposalMarket?: ProposalMarket;
                      reply?: {
                        proposedPick?: { outcome: string; reason: string };
                      };
                    }
                  | undefined);
              if (
                !proposed?.reply?.proposedPick ||
                proposed.reply.proposedPick.outcome !== b.pick.outcome ||
                proposed.reply.proposedPick.reason !== b.pick.reason
              )
                throw Error("EXACT_RUNTIME_PROPOSAL_REQUIRED");
              assertJourneyProposalMarket(
                proposed.proposalMarket,
                b.pick,
                state.eventId,
              );
              assertKnownAt(
                state.now,
                [b.pick.snapshot.fetchedAt, b.pick.snapshot.priceAsOf],
                "FUTURE_EVIDENCE",
              );
              trace.result = await createPick(
                pool,
                state.ownerId,
                {
                  platform: b.pick.platform,
                  nativeId: b.pick.nativeId,
                  outcome: b.pick.outcome,
                  reason: b.pick.reason,
                  requestId: requestId(),
                },
                async () => b.pick!.snapshot,
              );
              break;
            }
            case "user_reject":
              trace.result = {
                rejected: action.proposalId,
                savedPickMutations: 0,
              };
              break;
            case "consent":
              if (!state.sessionId) throw Error("SESSION_REQUIRED");
              await setChatMemoryConsent(
                pool,
                state.ownerId,
                state.sessionId,
                action.enabled,
              );
              await setActionMemoryConsent(pool, state.ownerId, action.enabled);
              state.consent = action.enabled;
              trace.result = { enabled: state.consent };
              break;
            case "observe_result": {
              if (!b.settlement) {
                trace.status = "awaiting_binding";
                break;
              }
              assertKnownAt(
                state.now,
                [action.availableAt, b.settlement.retrievedAt],
                "FUTURE_RESULT",
              );
              const pick = Object.values(state.refs).find(
                (v) => v && typeof v === "object" && "pickId" in v,
              ) as { pickId: string } | undefined;
              if (!pick) throw Error("CONFIRMED_PICK_REQUIRED");
              await recordActionSettlement(pool, pick.pickId, b.settlement);
              trace.result = (
                await pool.query(
                  "SELECT revision,payload FROM confirmed_action_results WHERE pick_id=$1 AND user_id=$2 ORDER BY revision DESC LIMIT 1",
                  [pick.pickId, state.ownerId],
                )
              ).rows[0];
              if (
                !trace.result ||
                (trace.result as { revision: number }).revision !==
                  action.version
              )
                throw Error("APPLICATION_RESULT_VERSION_MISMATCH");
              break;
            }
            case "propose_lesson":
              if (!binding?.candidate || !b.experience) {
                trace.status = "awaiting_binding";
                break;
              }
              if (!state.consent) throw Error("MEMORY_CONSENT_REQUIRED");
              const observed = fixture.steps
                .filter(
                  (s) =>
                    s.action.type === "observe_result" &&
                    s.action.resultId === action.resultId,
                )
                .map((s) => state.refs[s.id])
                .filter(Boolean)
                .at(-1) as { revision: number } | undefined;
              if (!observed || observed.revision !== action.resultVersion)
                throw Error("RESULT_NOT_CURRENT");
              state.refs[`experience:${step.id}`] =
                await recordLearningExperience(
                  pool,
                  state.ownerId,
                  b.experience,
                );
              trace.result = await createLessonCandidate(
                pool,
                state.ownerId,
                resolveJourneyRefs(binding!.candidate, state.refs),
              );
              break;
            case "user_review": {
              if (!b.review) {
                trace.status = "awaiting_binding";
                break;
              }
              const freshReview = await resolveJourneyHumanBinding(
                pool,
                state.ownerId,
                fixture,
                action,
                binding,
                state.refs,
              );
              if (
                journeyHash(freshReview) !== journeyHash(resolvedHumanBinding)
              )
                throw Error("REVIEW_AUTHORITY_CHANGED");
              const authority = freshReview!.reviewAuthority!;
              const original = fixture.steps.find(
                (s) =>
                  s.action.type === "propose_lesson" &&
                  s.action.lessonId === action.lessonId,
              );
              const candidate =
                original &&
                (state.refs[original.id] as { id: string } | undefined);
              if (!candidate) throw Error("APPLICATION_CANDIDATE_REQUIRED");
              if (["approve", "reject", "edit"].includes(action.decision)) {
                if (b.review.action !== action.decision)
                  throw Error("HUMAN_REVIEW_ACTION_MISMATCH");
                trace.result = await reviewLessonCandidate(
                  pool,
                  state.ownerId,
                  authority.candidate.id,
                  { ...b.review, requestId: requestId(), confirmed: true },
                );
              } else {
                if (!authority.lesson)
                  throw Error("APPLICATION_LESSON_REQUIRED");
                trace.result = await updateReviewedLesson(
                  pool,
                  state.ownerId,
                  authority.lesson.id,
                  {
                    requestId: requestId(),
                    baseVersion: authority.lesson.version,
                    confirmed: true,
                    action: action.decision === "pause" ? "paused" : "retired",
                  },
                );
              }
              break;
            }
          }
        } catch (error) {
          trace.status = "failed";
          trace.diagnostic =
            error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
              ? error.message
              : "APPLICATION_SERVICE_FAILED";
        }
      trace.latencyMs = Date.now() - started;
      state.traces.push(trace);
      if (trace.status === "completed") state.refs[step.id] = trace.result;
      await persist();
      await input.onTrace?.(trace);
      if (trace.status !== "completed") break;
    }
    return {
      fixtureId: fixture.id,
      execution: "actual_application_services" as const,
      fixtureData: "synthetic_corpus" as const,
      status: state.traces.at(-1)?.status ?? "awaiting_binding",
      state,
      hostedAcceptance: false,
      independentHumanReview: false,
      predictiveClaim: false,
    };
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
      lockKey,
    ]);
    lock.release();
  }
}
