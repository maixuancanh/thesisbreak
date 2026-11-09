import { z } from "zod";
import type { SourceWatchConfig } from "./source-watch";
import { readChangedetectionSnapshot } from "./changedetection-adapter";
/** Explicit opt in and exact hostname allowlist. No browser or service credentials are serialized. */
export function sourceWatchConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SourceWatchConfig {
  const config: SourceWatchConfig = {
    enabled: env.SOURCE_WATCH_ENABLED === "true",
    publisherHosts: (env.SOURCE_WATCH_PUBLISHER_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  };
  const reportTarget = z
    .object({
      reportId: z.string().min(1).max(300),
      claimId: z.string().min(1).max(300),
      eventId: z.string().min(1).max(300),
      subjectId: z.string().min(1).max(300),
    })
    .strict();
  const officialTarget = z
    .object({
      target: z
        .object({
          gameId: z.string().regex(/^\d{10}$/),
          eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          homeTeam: z.string().min(1).max(80),
          awayTeam: z.string().min(1).max(80),
        })
        .strict(),
      personId: z.number().int().positive(),
      eventId: z.string().min(1).max(300),
    })
    .strict();
  if (env.SOURCE_WATCH_REVIEWED_REPORT_TARGETS_JSON) {
    const raw = env.SOURCE_WATCH_REVIEWED_REPORT_TARGETS_JSON;
    if (raw.length > 32000) throw Error("REPORT_TARGET_CONFIG_LIMIT");
    config.reviewedReportTargets = z
      .record(z.string().min(1).max(300), reportTarget)
      .refine((v) => Object.keys(v).length <= 25)
      .parse(JSON.parse(raw));
  }
  if (env.SOURCE_WATCH_OFFICIAL_LINEUP_TARGETS_JSON) {
    const raw = env.SOURCE_WATCH_OFFICIAL_LINEUP_TARGETS_JSON;
    if (raw.length > 32000) throw Error("LINEUP_TARGET_CONFIG_LIMIT");
    config.officialLineupTargets = z
      .record(z.string().min(1).max(300), officialTarget)
      .refine((v) => Object.keys(v).length <= 25)
      .parse(JSON.parse(raw));
  }
  const baseUrl = env.SOURCE_WATCH_SERVICE_URL,
    apiKey = env.SOURCE_WATCH_SERVICE_KEY;
  if (baseUrl && apiKey) {
    const hosts = (env.SOURCE_WATCH_SERVICE_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    config.readServiceSnapshot = async (serviceWatchId, w) => {
      const result = await readChangedetectionSnapshot({
        baseUrl,
        apiKey,
        serviceWatchId,
        hosts,
        binding: {
          eventId: String(w.event_id),
          originId: String(w.origin_id),
          url: String(w.url),
          contentClass: "html",
          selector: String(w.selector),
        },
      });
      return result.snapshot;
    };
  }
  return config;
}
