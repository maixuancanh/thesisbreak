import { it, expect, vi, afterEach } from "vitest";
import { createOfficialPlanner } from "../../packages/agent/src/provider";
afterEach(() => vi.unstubAllGlobals());
it("sends the planner's structured schema to a compatible provider", async () => {
  let request: Record<string, unknown> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      request = JSON.parse(String(init.body));
      return Response.json({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: "fixture",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({ tools: [] }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }),
  );
  const plan = createOfficialPlanner({
    LLM_BASE_URL: "https://fixture.test/v1",
    LLM_API_KEY: "offline",
    LLM_MODEL: "cx/fixture",
  });
  expect(
    await plan({
      message: "Explain",
      market: {
        platform: "kalshi",
        nativeId: "TEST",
        question: "Fixture?",
        outcomes: ["Yes", "No"],
        rules: "Rules",
      },
      history: [],
    }),
  ).toEqual({ tools: [] });
  expect(request.response_format).toMatchObject({ type: "json_schema" });
  expect(request.reasoning_effort).toBe("low");
  expect(JSON.stringify(request.messages)).toContain("additionalProperties");
});
