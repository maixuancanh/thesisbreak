"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { z } from "zod";
import { lessonVersionSchema } from "../../../packages/domain/src/lesson";
import { briefingQuerySchema } from "../../../packages/domain/src/research-memory";
import {
  liveMarketPath,
  type LivePlatform,
  type LiveProvider,
} from "../lib/live-market";

export const memorySourceSchema = z.object({
  id: z.string(),
  url: z.string(),
  retrievedAt: z.string(),
});
// Only known evidence publishers can open a new tab. Unsupported sources stay text.
const evidenceHosts = [
  "kalshi.com",
  "polymarket.com",
  "nba.com",
  "wnba.com",
  "federalreserve.gov",
  "balldontlie.io",
];
export function safeEvidenceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      return;
    if (
      evidenceHosts.some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    )
      return url.href;
  } catch {
    /* Unsupported evidence remains readable without a link. */
  }
}
export function MemorySources({
  sources,
}: {
  sources: z.infer<typeof memorySourceSchema>[];
}) {
  return sources.length ? (
    <div className="agent-citations">
      {sources.map((source, i) => {
        const href = safeEvidenceUrl(source.url);
        return href ? (
          <a
            key={`${source.id}:${i}`}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
          >
            [{i + 1}] {source.id}
          </a>
        ) : (
          <span key={`${source.id}:${i}`}>
            [{i + 1}] {source.id} (saved reference)
          </span>
        );
      })}
    </div>
  ) : (
    <p className="small muted">No linked source was recorded.</p>
  );
}
const origin = z.object({
  runId: z.string(),
  platform: z.enum(["kalshi", "polymarket"]),
  nativeId: z.string().min(1),
  recordedAt: z.string(),
});
const lessonHistory = z.object({
  currentVersion: z.number().int().positive(),
  lesson: lessonVersionSchema,
  origin: origin.nullable(),
});
const briefingSchema = z.object({
  schemaVersion: z.literal(1),
  market: briefingQuerySchema,
  generatedAt: z.string(),
  contextStatus: z.enum(["recorded", "live", "unavailable"]),
  currentPick: z
    .object({
      id: z.string(),
      version: z.number().int().positive(),
      outcome: z.string(),
      reason: z.string().nullable(),
      assumptions: z.array(z.unknown()),
      recordedAt: z.string(),
    })
    .nullable(),
  lastConversation: z
    .object({
      runId: z.string(),
      message: z.string(),
      reply: z.string(),
      recordedAt: z.string(),
      sources: z.array(memorySourceSchema).max(100),
    })
    .nullable(),
  applicableLessons: z.array(lessonHistory).max(2000),
  lessonHistory: z.array(lessonHistory).max(2000),
});
function Lesson({ row }: { row: z.infer<typeof lessonHistory> }) {
  return (
    <div>
      <p>
        {row.lesson.rule}{" "}
        <span className="small muted">
          · v{row.lesson.version} · {row.lesson.status}
        </span>
      </p>
      {row.origin ? (
        <Link
          className="small"
          href={`${liveMarketPath({ platform: row.origin.platform, id: row.origin.nativeId })}#run-${encodeURIComponent(row.origin.runId)}`}
        >
          Origin conversation
        </Link>
      ) : (
        <p className="small muted">Added without a linked conversation.</p>
      )}
    </div>
  );
}
export function ResearchBriefing({
  platform,
  nativeId,
  provider,
  signedIn,
  refreshKey,
}: {
  platform: LivePlatform;
  nativeId: string;
  provider: LiveProvider;
  signedIn: boolean;
  refreshKey: string;
}) {
  const [data, setData] = useState<z.infer<typeof briefingSchema> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError("");
    if (signedIn)
      void fetch(
        `/api/agent/briefing?${new URLSearchParams({ platform, id: nativeId, provider })}`,
        { cache: "no-store", signal: controller.signal },
      )
        .then(async (response) => {
          if (!response.ok)
            throw new Error("Your saved context could not be loaded.");
          const result = briefingSchema.parse(await response.json());
          if (
            result.market.platform !== platform ||
            result.market.id !== nativeId ||
            result.market.provider !== provider
          )
            throw new Error(
              "Your saved context could not be matched to this event.",
            );
          if (!controller.signal.aborted) setData(result);
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError(
              "Your saved context is unavailable. You can still review this conversation.",
            );
        });
    return () => controller.abort();
  }, [platform, nativeId, provider, signedIn, refreshKey]);
  if (!signedIn) return null;
  if (
    data &&
    !data.currentPick &&
    !data.lastConversation &&
    !data.lessonHistory.length
  )
    return null;
  return (
    <section className="agent-used-memory" aria-label="Your saved context">
      <details>
        <summary>Where you left off</summary>
        {error ? (
          <p role="status" className="small muted">
            {error}
          </p>
        ) : !data ? (
          <p role="status" className="small muted">
            Loading saved context…
          </p>
        ) : (
          <>
            {data.currentPick ? (
              <div>
                <p className="eyebrow">
                  Current pick · v{data.currentPick.version}
                </p>
                <p>{data.currentPick.outcome}</p>
                <p className="small muted">
                  {data.currentPick.reason || "No reason saved."}
                </p>
              </div>
            ) : (
              <p className="small muted">No pick saved for this event.</p>
            )}
            {data.lastConversation ? (
              <details>
                <summary>Last conversation</summary>
                <p className="small">You: {data.lastConversation.message}</p>
                <p className="small">Thesis: {data.lastConversation.reply}</p>
                <MemorySources sources={data.lastConversation.sources} />
              </details>
            ) : (
              <p className="small muted">No completed conversation yet.</p>
            )}
            <p className="eyebrow">Applicable preferences</p>
            {data.contextStatus !== "live" ? (
              <p className="small muted">
                Current event scope is unavailable, so applicability has not
                been checked.
              </p>
            ) : data.applicableLessons.length ? (
              data.applicableLessons
                .filter(
                  (row) =>
                    row.currentVersion === row.lesson.version &&
                    row.lesson.approval === "approved" &&
                    row.lesson.status === "active" &&
                    row.lesson.supersededBy === null,
                )
                .map((row) => (
                  <Lesson
                    key={`${row.lesson.id}:${row.lesson.version}`}
                    row={row}
                  />
                ))
            ) : (
              <p className="small muted">
                No approved preference applies to this event.
              </p>
            )}
            <details>
              <summary>
                Preference version history ({data.lessonHistory.length})
              </summary>
              <p className="small muted">
                Account history includes older, paused and retired versions.
                These are not automatically used.
              </p>
              {data.lessonHistory.map((row) => (
                <Lesson
                  key={`${row.lesson.id}:${row.lesson.version}`}
                  row={row}
                />
              ))}
            </details>
          </>
        )}
      </details>
    </section>
  );
}
