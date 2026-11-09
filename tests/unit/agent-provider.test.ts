import { it, expect, vi, afterEach } from "vitest";
import { createOfficialPlanner } from "../../packages/agent/src/provider";
afterEach(() => vi.unstubAllGlobals());
it("sends exact context citation enums in nested review output schema", async () => {
  const { createOfficialGenerator } =
    await import("../../packages/agent/src/provider");
  let body: Record<string, unknown> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      body = JSON.parse(String(init.body));
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
              content: JSON.stringify({
                message: "Unclear.",
                evidenceRefs: ["source-a"],
                lessonRefs: [],
                proposedChange: null,
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }),
  );
  await createOfficialGenerator({
    LLM_BASE_URL: "https://fixture.test/v1",
    LLM_API_KEY: "offline",
    LLM_MODEL: "fixture",
  })({
    system: "Fixture",
    prompt: "Fixture",
    citationScope: { evidenceIds: ["source-a"], lessonIds: ["lesson-a"] },
  });
  const format = body.response_format as {
    json_schema: { schema: { properties: Record<string, unknown> } };
  };
  expect(
    JSON.stringify(format.json_schema.schema.properties.reasonReview),
  ).toContain("source-a");
  expect(
    JSON.stringify(format.json_schema.schema.properties.retrospective),
  ).toContain("source-a");
  expect(
    JSON.stringify(format.json_schema.schema.properties.lessonRefs),
  ).toContain("lesson-a");
});
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

it.each([
  ["generation", 503, "GENERATION_UNAVAILABLE", "upstream_server"],
  ["planning", 429, "PLANNING_UNAVAILABLE", "upstream_rate_limit"],
] as const)(
  "preserves %s upstream failures without hidden retries",
  async (operation, status, expected, category) => {
    const { createOfficialGenerator } =
      await import("../../packages/agent/src/provider");
    const { failureCategory } =
      await import("../../apps/web/lib/server/request-diagnostics");
    const fetch = vi.fn(async () =>
      Response.json(
        { error: { message: "private provider payload", type: "error" } },
        { status },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const env = {
      LLM_BASE_URL: "https://fixture.test/v1",
      LLM_API_KEY: "offline",
      LLM_MODEL: "fixture",
    };
    const call =
      operation === "generation"
        ? createOfficialGenerator(env)({ system: "fixture", prompt: "fixture" })
        : createOfficialPlanner(env)({
            message: "Explain",
            market: {
              platform: "kalshi",
              nativeId: "TEST",
              question: "Fixture?",
              outcomes: ["Yes", "No"],
              rules: "Rules",
            },
            history: [],
          });
    const error = await call.then(
      () => null,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(expected);
    expect(failureCategory(error)).toBe(category);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("propagates caller cancellation through the planner provider request", async () => {
  let signal: AbortSignal | undefined;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined;
      started();
      return new Promise<Response>((_, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), {
          once: true,
        });
      });
    }),
  );
  const controller = new AbortController();
  const plan = createOfficialPlanner(
    {
      LLM_BASE_URL: "https://fixture.test/v1",
      LLM_API_KEY: "offline",
      LLM_MODEL: "fixture",
    },
    undefined,
    controller.signal,
  );
  const result = plan({
    message: "Explain",
    market: {
      platform: "kalshi",
      nativeId: "TEST",
      question: "Fixture?",
      outcomes: ["Yes", "No"],
      rules: "Rules",
    },
    history: [],
  });
  const failure = expect(result).rejects.toThrow("PLANNING_UNAVAILABLE");
  await ready;
  controller.abort();
  await failure;
  expect(signal?.aborted).toBe(true);
});
