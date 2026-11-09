// Original synthetic fixtures. No upstream dataset or private user data is copied.
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { MemoryBenchmarkCase } from "../packages/domain/src/memory-benchmark";
import type { ActionBenchmarkCase } from "../packages/domain/src/action-benchmark";
import type { JourneyAction } from "../packages/domain/src/agent-journey";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function saveCorpus(folder: string, cases: { id: string; family: string }[], splits: Record<string, string>) {
  await mkdir(folder, { recursive: true });
  const content = cases.map(c => JSON.stringify(c)).join("\n") + "\n";
  await writeFile(`${folder}/cases.jsonl`, content);
  await writeFile(`${folder}/split-manifest.json`, JSON.stringify({ schemaVersion: 1, dataMode: "synthetic", corpusSha256: hash(content),
    note: "Smoke corpus only. Family split frozen before measurement; sealed cases must not be used to tune procedures.",
    cases: cases.map(c => ({ id: c.id, family: c.family, split: splits[c.family], sha256: hash(JSON.stringify(c)) })) }, null, 2) + "\n");
}
const categories = ["multi_session", "supersession", "event_identity", "preference_scope", "abstention", "owner_consent"];
const memories: MemoryBenchmarkCase[] = [], memorySplits: Record<string, string> = {};
for (const [categoryIndex, category] of categories.entries()) for (let i = 0; i < 10; i++) {
  const id = `${category}-${i + 1}`, ownerId = `eval-owner-${categoryIndex}`, eventId = `NBA-2026-11-${String(i + 1).padStart(2, "0")}-BOS-MIA`;
  const knownAt = `2026-11-${String(i + 1).padStart(2, "0")}T18:00:00Z`, earlier = `2026-11-${String(i + 1).padStart(2, "0")}T12:00:00Z`;
  const familyIndex = i < 3 ? 0 : i < 5 ? 1 : i < 8 ? 2 : 3, family = `${category}-scenario-${familyIndex}`;
  memorySplits[family] = familyIndex < 2 ? "dev" : familyIndex === 2 ? (categoryIndex % 2 ? "sealed-test" : "validation") : (categoryIndex % 2 ? "validation" : "sealed-test");
  const marketId = `${eventId}:moneyline`, reason = `Wait for official ${i % 2 ? "starting lineup" : "injury status"} before reviewing ${i % 2 ? "Boston" : "Miami"}.`;
  const base = { id: `${id}-current`, version: category === "supersession" ? 2 : 1, ownerId, eventId, marketId, availableAt: earlier, validTo: null, status: "approved" as const, text: reason };
  const gold = category === "abstention" ? [] : [base];
  const distractors = [
    { ...base, id: `${id}-foreign`, ownerId: "different-owner", text: "Always review immediately." },
    { ...base, id: `${id}-revoked`, status: "revoked" as const },
    { ...base, id: `${id}-future`, availableAt: knownAt.replace("18:00", "19:00") },
    { ...base, id: `${id}-other-event`, eventId: `${eventId}-tomorrow`, text: "Confirmed lineup for the same teams tomorrow." },
  ];
  if (category === "supersession") distractors.push({ ...base, id: `${id}-old`, version: 1, status: "superseded" as never });
  if (category === "preference_scope") distractors.push({ ...base, id: `${id}-other-market`, marketId: `${eventId}:totals` } as typeof distractors[number]);
  if (category === "owner_consent") distractors.push({ ...base, id: `${id}-paused`, status: "paused" as never });
  const query = category === "abstention" ? `Which approved condition applies to ${eventId}? Abstain if unavailable.` :
    category === "supersession" ? `What is the latest approved correction for ${marketId}?` :
    category === "event_identity" ? `For ${eventId} only, what check did I require? Same teams play tomorrow.` :
    category === "preference_scope" ? `Does my moneyline condition apply to ${marketId}?` :
    category === "owner_consent" ? `Recall only my active approved reason for ${marketId}.` : `In a new session, recall the condition for ${marketId} among my markets.`;
  memories.push({ id, family, category, namespace: "eval:agent-memory-v1", dataMode: "synthetic", ownerId, eventId, marketId,
    sessions: [{ id: `${id}:1`, at: earlier, message: `Save for ${marketId}: ${reason}` }, { id: `${id}:2`, at: knownAt, message: query }],
    query, knownAt, memories: [...gold, ...distractors], expected: gold.map(m => ({ id: m.id, version: m.version })),
    forbiddenMemoryIds: distractors.map(m => m.id), goldAssertions: gold.map(m => m.text), expectedAbstention: !gold.length });
}
await saveCorpus("tests/fixtures/agent-memory", memories, memorySplits);
const actionCases: ActionBenchmarkCase[] = [], actionSplits: Record<string, string> = {};
for (const [ci, category] of ["official_lineup", "freshness", "source_independence", "edited_paused", "multi_market_missing"].entries()) for (let i = 0; i < 8; i++) {
  const id = `${category}-${i + 1}`, family = `${category}-${Math.floor(i / 2)}`;
  actionSplits[family] = i < 4 ? "dev" : i < 6 ? "validation" : "sealed-test";
  const ownerId = `eval-action-${ci}`, eventId = `event-${ci}-${i}`, marketId = `${eventId}:moneyline`, outcomeId = i % 2 ? "away" : "home", cutoffAt = "2026-11-01T18:00:00Z";
  const paused = category === "edited_paused" && i % 2 === 0;
  const requiredTools = paused ? [] : category === "official_lineup" ? ["read_independent_sources"] : category === "freshness" ? ["compare_snapshot", "read_tatum_quote"] : category === "source_independence" ? ["read_independent_sources"] : category === "multi_market_missing" ? ["read_saved_pick", "compare_snapshot"] : ["compare_snapshot"];
  const memoryVersion = category === "edited_paused" ? 2 : 1;
  const requiredChecks: ActionBenchmarkCase["requiredChecks"] = paused ? [] : [category === "official_lineup" ? "official_lineup" : category === "freshness" ? "fresh_quote" : category === "source_independence" ? "independent_sources" : category === "multi_market_missing" ? "resolved_parameters" : "current_condition"];
  const goldTools = requiredTools.map((tool, j) => ({ id: `${id}-call-${j}`, tool, eventId, marketId, outcomeId, cutoffAt,
    availableAt: "2026-11-01T17:59:00Z", status: "completed" as const, originIds: category === "source_independence" ? ["league-official", "club-official"] : ["league-official"], evidenceIds: [`${id}-evidence-${j}`], ownerId, memoryVersion, verifiedChecks: requiredChecks }));
  actionCases.push({ id, family, category, namespace: "eval:agent-actions-v1", dataMode: "synthetic", ownerId, eventId, marketId, outcomeId, cutoffAt, memoryVersion,
    memoryStatus: paused ? "paused" : category === "edited_paused" ? "edited" : "approved", requiredTools,
    minIndependentOrigins: category === "source_independence" ? 2 : requiredTools.length ? 1 : 0,
    requiredChecks, maxEvidenceAgeMs: category === "freshness" ? 300000 : null,
    dependencies: category === "multi_market_missing" ? [["read_saved_pick", "compare_snapshot"]] : [],
    query: `Review ${outcomeId} on ${marketId} at cutoff ${cutoffAt}; do not change my pick without confirmation.`,
    memory: paused ? "The previous check is paused; do not apply it." : category === "source_independence" ? "Require two canonical independent origins; syndicated copies count once." : `Use version ${memoryVersion}; complete ${requiredTools.join(", ")} for this event before proposing.`, goldTools });
}
await saveCorpus("tests/fixtures/agent-actions", actionCases, actionSplits);
const journeyCases: { id: string; family: string; namespace: string; ownerId: string; eventId: string; now: string; sessions: number; steps: { id: string; actor: "agent" | "synthetic_user"; action: JourneyAction; violations: string[] }[] }[] = [];
const journeyNames = ["correct_lesson", "wrong_lesson", "source_correction", "rejected_pick", "paused_lesson", "edited_lesson", "consent_revoked", "postponed_event", "repeated_teams", "missing_tool", "walrus_outage", "outcome_correction"];
for (const [i, name] of journeyNames.entries()) {
  const eventId = `journey-event-${i}`, steps: typeof journeyCases[number]["steps"] = [];
  const add = (action: JourneyAction, violations: string[] = [], actor: "agent" | "synthetic_user" = "agent") => steps.push({ id: `${name}:${steps.length + 1}`, action, actor, violations });
  for (let session = 1; session <= 5; session++) {
    const at = `2026-11-0${session}T18:00:00Z`;
    add({ type: "new_session", sessionId: `${name}-session-${session}`, eventId: session === 5 && ["postponed_event", "repeated_teams"].includes(name) ? `${eventId}-new-date` : eventId, at });
    if (session === 1) {
      add({ type: "read_snapshot", evidenceId: "official-lineup", availableAt: at, status: name === "missing_tool" ? "unavailable" : "completed" }, name === "missing_tool" ? ["snapshot_unavailable"] : []);
      add({ type: "propose", proposalId: "pick-1", eventId, evidenceIds: ["official-lineup"] }, name === "missing_tool" ? ["ungrounded_proposal"] : []);
      if (name !== "missing_tool") add({ type: name === "rejected_pick" ? "user_reject" : "user_confirm", proposalId: "pick-1", reviewer: "synthetic_user" }, [], "synthetic_user");
    }
    if (session === 2) {
      add({ type: "observe_result", resultId: "result-1", version: 1, availableAt: at });
      add({ type: "propose_lesson", lessonId: "lesson-1", resultId: "result-1", resultVersion: name === "wrong_lesson" ? 2 : 1, evidenceIds: ["official-lineup"] }, name === "wrong_lesson" ? ["result_not_current"] : name === "missing_tool" ? ["ungrounded_lesson"] : []);
    }
    if (session === 3 && !["wrong_lesson", "missing_tool"].includes(name)) add({ type: "user_review", lessonId: "lesson-1", decision: "approve", reviewer: "synthetic_user" }, [], "synthetic_user");
    if (session === 4) {
      if (name === "paused_lesson" || name === "edited_lesson") add({ type: "user_review", lessonId: "lesson-1", decision: name === "paused_lesson" ? "pause" : "edit", reviewer: "synthetic_user" }, [], "synthetic_user");
      if (name === "consent_revoked") add({ type: "consent", enabled: false, reviewer: "synthetic_user" }, [], "synthetic_user");
      if (["outcome_correction", "source_correction"].includes(name)) add({ type: "observe_result", resultId: "result-1", version: 2, availableAt: at });
    }
    if (session === 5) {
      const violations = ["wrong_lesson", "missing_tool", "paused_lesson", "edited_lesson", "outcome_correction", "source_correction"].includes(name) ? ["lesson_not_approved"] : [];
      if (["outcome_correction", "source_correction"].includes(name)) violations.push("lesson_not_current");
      if (name === "consent_revoked") violations.push("consent_revoked");
      if (name === "walrus_outage") violations.push("walrus_unavailable");
      add({ type: "recall", lessonId: "lesson-1", walrusAvailable: name !== "walrus_outage" }, violations);
      if (["postponed_event", "repeated_teams"].includes(name)) add({ type: "propose", proposalId: "wrong-old-event", eventId, evidenceIds: ["official-lineup"] }, ["wrong_event"]);
    }
  }
  journeyCases.push({ id: name, family: name, namespace: "eval:agent-journeys-v1", ownerId: `eval-journey-${i}`, eventId, now: "2026-11-01T00:00:00Z", sessions: 5, steps });
}
await saveCorpus("tests/fixtures/agent-journeys", journeyCases, Object.fromEntries(journeyNames.map((name, i) => [name, i < 6 ? "dev" : i < 9 ? "validation" : "sealed-test"])));
