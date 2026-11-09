import { describe, expect, it, vi } from "vitest";
import {
  buildAutomaticChallengerInput,
  runAutomaticForecastChallenger,
} from "../../packages/integrations/src/forecast-challenger-worker";
import { triggerForecastChallenger } from "../../packages/integrations/src/cloudflare-forecast-cron";
import type { Pool } from "pg";
import { createHash } from "node:crypto";
const captured = "2030-01-01T00:00:00.000Z";
const body = '{"events":[{"id":"game"}]}';
const digest = createHash("sha256").update(body).digest("hex");
const row = {
  id: "forecast",
  user_id: "owner",
  namespace: "live",
  event_id: "game",
  horizon: "T60m",
  captured_at: captured,
  scheduled_at: "2030-01-01T01:00:00Z",
  payload: {
    namespace: "live",
    eventId: "game",
    horizon: "T60m",
    scheduledAt: "2030-01-01T01:00:00Z",
    homeTeam: "BOS",
    evidence: [
      {
        url: "https://site.api.espn.com/scoreboard",
        retrievedAt: captured,
        publishedAt: null,
        contentHash: digest,
      },
    ],
  },
};
const snapshot = {
  id: "snap",
  source_url: "https://site.api.espn.com/scoreboard",
  retrieved_at: captured,
  content_hash: "f".repeat(64),
  payload: { _originalResponse: body, _originalSha256: digest },
};
describe("automatic challenger frozen inputs", () => {
  it("defaults off without touching database or model and rejects unbounded quotas", async () => {
    const connect = vi.fn();
    const pool = { connect } as unknown as Pool;
    expect(await runAutomaticForecastChallenger(pool, {})).toEqual({
      status: "disabled",
    });
    expect(
      await runAutomaticForecastChallenger(pool, {
        FORECAST_CHALLENGER_MODE: "shadow",
      }),
    ).toEqual({ status: "disabled" });
    await expect(
      runAutomaticForecastChallenger(pool, {
        FORECAST_CHALLENGER_ENABLED: "true",
        FORECAST_CHALLENGER_MODE: "shadow",
        LLM_API_KEY: "test",
        LLM_MODEL: "test",
        LLM_BASE_URL: "https://example.invalid/v1",
        FORECAST_CHALLENGER_SERVICE_DAILY_CALLS: "301",
      }),
    ).rejects.toThrow("INVALID_CHALLENGER_QUOTA");
    expect(connect).not.toHaveBeenCalled();
  });
  it("cron only invokes its separate protected endpoint with explicit shadow flags", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}"));
    const env = { FORECAST_CRON_SECRET: "a".repeat(64) };
    await triggerForecastChallenger(env, transport);
    expect(transport).not.toHaveBeenCalled();
    await triggerForecastChallenger(
      {
        ...env,
        FORECAST_CHALLENGER_MODE: "shadow",
        FORECAST_CHALLENGER_ENABLED: "true",
      },
      transport,
    );
    expect(transport.mock.calls[0]?.[0]).toBe(
      "https://thesisbreak.vercel.app/api/internal/forecast-challenger",
    );
    expect(transport.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(transport.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: `Bearer ${env.FORECAST_CRON_SECRET}`,
    });
  });
  it("uses actual retained body with unknown publication preserved and separate prospective namespace", () => {
    const result = buildAutomaticChallengerInput(row, [snapshot], "model");
    expect(result.envelope.mode).toBe("prospective");
    expect(result.envelope.namespace).toBe("forecast-shadow:live");
    expect(result.envelope.evidence[0]!.publishedAt).toBeNull();
    expect(result.artifacts).toEqual([{ id: "snap", text: body }]);
    expect(result.envelope.maxCalls).toBe(3);
  });
  it("refuses missing, altered, future, and wrong-event captures", () => {
    expect(() => buildAutomaticChallengerInput(row, [], "model")).toThrow(
      "RETAINED_EVIDENCE_UNAVAILABLE",
    );
    expect(() =>
      buildAutomaticChallengerInput(
        row,
        [
          {
            ...snapshot,
            payload: { ...snapshot.payload, _originalResponse: "tampered" },
          },
        ],
        "model",
      ),
    ).toThrow("RETAINED_EVIDENCE_HASH_MISMATCH");
    expect(() =>
      buildAutomaticChallengerInput(
        row,
        [{ ...snapshot, retrieved_at: "2030-01-01T00:01:00Z" }],
        "model",
      ),
    ).toThrow();
    expect(() =>
      buildAutomaticChallengerInput(
        { ...row, captured_at: "2029-12-31T23:00:00Z" },
        [snapshot],
        "model",
      ),
    ).toThrow("INVALID_LIVE_HORIZON");
    expect(() =>
      buildAutomaticChallengerInput(
        { ...row, payload: { ...row.payload, eventId: "other" } },
        [snapshot],
        "model",
      ),
    ).toThrow("FORECAST_BINDING_MISMATCH");
  });
});
