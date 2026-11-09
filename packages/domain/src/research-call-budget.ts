/** One run-wide reservation counter; retries must reserve again before dispatch. */
export function researchCallBudget(maxCalls: number) {
  if (!Number.isInteger(maxCalls) || maxCalls < 2 || maxCalls > 5)
    throw Error("INVALID_RESEARCH_CALL_CAP");
  let used = 0;
  return {
    reserve(count: number) {
      if (!Number.isInteger(count) || count < 1 || used + count > maxCalls)
        return false;
      used += count;
      return true;
    },
    get used() {
      return used;
    },
  };
}
