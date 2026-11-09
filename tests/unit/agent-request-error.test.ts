import { expect, it } from "vitest";
import { agentRequestError } from "../../apps/web/lib/agent-request-error";
it("distinguishes clarification, authentication and transient failure without leaking backend detail", () => {
  expect(
    agentRequestError(422, {
      error: "MARKET_REFERENCE_CLARIFICATION_REQUIRED",
    }),
  ).toMatch(/Which market/);
  expect(
    agentRequestError(422, {
      error: "HISTORICAL_CUTOFF_CLARIFICATION_REQUIRED",
    }),
  ).toMatch(/timezone/);
  expect(agentRequestError(401, {})).toMatch(/Sign in/);
  expect(
    agentRequestError(503, {
      error: "SECRET_INTERNAL_DETAIL",
      message: "private",
    }),
  ).not.toMatch(/SECRET|private/);
});
