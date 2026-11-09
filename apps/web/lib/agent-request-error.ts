/** Show actionable, server-defined clarification without exposing raw backend errors. */
export function agentRequestError(status: number, payload: unknown) {
  const code =
    payload && typeof payload === "object" && "error" in payload
      ? payload.error
      : null;
  if (status === 422) {
    if (code === "MARKET_REFERENCE_CLARIFICATION_REQUIRED")
      return "Which market do you mean? Choose the event and date from the sidebar.";
    if (code === "HISTORICAL_CUTOFF_CLARIFICATION_REQUIRED")
      return "What date, time and timezone should I use? For example: as of 2026-10-29T12:30:00+07:00.";
    if (code === "HISTORICAL_MARKET_REFERENCE_REQUIRED")
      return "Choose the exact market from your history, or include its market ID.";
    if (code === "HISTORICAL_CUTOFF_IN_FUTURE")
      return "Choose a time in the past to review what was known then.";
  }
  if (status === 401) return "Sign in to continue. Your message is kept here.";
  if (status === 429)
    return "You’ve reached the request limit. Your message is kept; try again later.";
  if (status === 409)
    return "Another reply is still being prepared, or your request changed. Retry shortly.";
  return "Thesis couldn't finish this request. Your message is kept; retry to check its status.";
}
