import { z } from "zod";
import { lessonVersionSchema } from "../../domain/src/lesson";
import {
  MEMORY_COMPARISON_NOTE,
  comparisonReplySchema,
  memoryComparisonSchema,
  type ComparisonReply,
  type MemoryComparison,
} from "../../domain/src/memory-comparison";
import {
  answerWithContext,
  createAgentContext,
  type AgentContext,
  type GenerateReply,
} from "./context";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function present(
  reply: Awaited<ReturnType<typeof answerWithContext>>,
): ComparisonReply {
  const { proposedPick: _pick, proposedChange: _change, ...plain } = reply;
  void _pick;
  void _change;
  return comparisonReplySchema.parse(plain);
}
function analysisText(reply: ComparisonReply) {
  // Citation identifiers, ordering and spacing do not measure changed reasoning.
  return JSON.stringify(reply, (key, value: unknown) => {
    if (key === "evidenceRefs" || key === "lessonRefs") return undefined;
    return typeof value === "string"
      ? value.trim().replace(/\s+/g, " ")
      : value;
  });
}

/** Caller must reconstruct current authorized context immediately before this call.
 * This function has no data readers, writes, tools or authority to approve proposals.
 */
export async function compareMemoryContext(input: {
  context: AgentContext;
  message: string;
  history: { role: "user" | "assistant"; text: string }[];
  generate: GenerateReply;
  signal?: AbortSignal;
  sessionMemories?: unknown[];
}): Promise<MemoryComparison> {
  const message = z.string().trim().min(1).max(10000).parse(input.message);
  // Clone synchronously: caller changes during either generation cannot alter the pair.
  const supplied = structuredClone(input.context);
  const sessionMemories = freeze(structuredClone(input.sessionMemories ?? []));
  const owner =
    supplied.pick?.userId ??
    supplied.evidence[0]?.userId ??
    supplied.lessons[0]?.userId ??
    "comparison-empty";
  // Reuse bounded validation without reconstructing scope/time authority from incomplete
  // AgentContext metadata. Approved lesson applicability belongs to createAgentContext.
  const checked = createAgentContext({
    userId: owner,
    market: supplied.market,
    pick: supplied.pick,
    evidence: supplied.evidence,
    lessons: [],
    settlement: supplied.settlement,
    now: new Date(),
  });
  const lessons = z.array(lessonVersionSchema).max(50).parse(supplied.lessons);
  for (const lesson of lessons) {
    if (
      lesson.userId !== owner ||
      lesson.approval !== "approved" ||
      lesson.status !== "active" ||
      lesson.supersededBy !== null
    )
      throw new Error("UNAUTHORIZED_COMPARISON_LESSON");
    if (JSON.stringify(lesson).length > 12000)
      throw new Error("LESSON_CONTEXT_TOO_LARGE");
  }
  const sourceMemories = supplied.sourceMemories ?? [];
  if (sourceMemories.some((s) => s.userId !== owner))
    throw new Error("UNAUTHORIZED_COMPARISON_SOURCE");
  const context = freeze({ ...checked, lessons, sourceMemories });
  const common = {
    experimental: true as const,
    historyPolicy: "excluded_from_both" as const,
    note: MEMORY_COMPARISON_NOTE,
  };
  if (
    !context.lessons.length &&
    !context.sourceMemories.length &&
    !sessionMemories.length
  )
    return memoryComparisonSchema.parse({
      ...common,
      status: "no_applicable_memory",
      withMemory: null,
      withoutMemory: null,
      lessonVersions: [],
      changed: false,
    });
  input.signal?.throwIfAborted();
  const withMemory = present(
    await answerWithContext(
      context,
      message,
      input.generate,
      input.signal,
      [],
      sessionMemories,
    ),
  );
  input.signal?.throwIfAborted();
  const withoutMemory = present(
    await answerWithContext(
      freeze({ ...context, lessons: [], sourceMemories: [] }),
      message,
      input.generate,
      input.signal,
      [],
    ),
  );
  return memoryComparisonSchema.parse({
    ...common,
    status: "compared",
    withMemory,
    withoutMemory,
    lessonVersions: context.lessons.map(({ id, version }) => ({ id, version })),
    sourceVersions: context.sourceMemories.map(({ id, version }) => ({
      id,
      version,
    })),
    sessionVersions: sessionMemories.map((m) =>
      z
        .object({
          sessionId: z.string(),
          version: z.number().int().positive(),
          blobId: z.string(),
        })
        .parse(m),
    ),
    changed: analysisText(withMemory) !== analysisText(withoutMemory),
  });
}
