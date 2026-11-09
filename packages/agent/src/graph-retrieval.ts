import {
  rankMemoryEdges,
  memoryIndexQuerySchema,
  type MemoryIndexQuery,
} from "../../domain/src/memory-index";
import {
  memoryPointerSchema,
  type MemoryPointer,
} from "../../domain/src/strengthening-contracts";
export type GraphRetrievalDependencies = {
  search: (query: MemoryIndexQuery) => Promise<unknown[]>;
  /** Must check current consent, version, pause/revoke, supersession and scope. */
  authorize: (
    pointer: MemoryPointer,
    query: MemoryIndexQuery,
  ) => Promise<boolean>;
  /** Must verify remote blob bytes/hash/version before returning content. */
  readExact: (
    pointer: MemoryPointer,
  ) => Promise<{ pointer: MemoryPointer; text: string } | null>;
};
/** Graph and lexical adapters share this gate. Index prose never enters model context. */
export async function retrieveGraphContext(
  rawQuery: MemoryIndexQuery,
  deps: GraphRetrievalDependencies,
) {
  const query = memoryIndexQuerySchema.parse(rawQuery);
  const items: { pointer: MemoryPointer; text: string }[] = [];
  const rejected: { memoryId: string; reason: string }[] = [];
  let edges: unknown[];
  try {
    edges = await deps.search(query);
  } catch {
    return {
      status: "unavailable" as const,
      items,
      rejected,
      mode: "lexical_entity" as const,
    };
  }
  let budget = query.maxCharacters ?? 16000;
  for (const edge of rankMemoryEdges(query, edges)) {
    const pointer = edge.pointer;
    let reason: string | null = null;
    try {
      if (!(await deps.authorize(pointer, query)))
        reason = "current_authority_denied";
      else {
        const content = await deps.readExact(pointer);
        const parsed = memoryPointerSchema.safeParse(content?.pointer);
        if (
          !content ||
          !parsed.success ||
          Object.keys(pointer).some(
            (key) =>
              pointer[key as keyof MemoryPointer] !==
              parsed.data[key as keyof MemoryPointer],
          )
        )
          reason = "readback_mismatch";
        else if (!(await deps.authorize(pointer, query)))
          reason = "authority_changed_during_read";
        else if (
          items.length >= (query.finalK ?? 5) ||
          content.text.length > budget
        )
          reason = "context_budget";
        else {
          items.push({ pointer, text: content.text });
          budget -= content.text.length;
        }
      }
    } catch {
      reason = "verification_unavailable";
    }
    if (reason) rejected.push({ memoryId: pointer.memoryId, reason });
  }
  return {
    status: "ok" as const,
    items,
    rejected,
    mode: "lexical_entity" as const,
  };
}
