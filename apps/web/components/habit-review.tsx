"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { z } from "zod";
import { liveMarketPath } from "../lib/live-market";
import { MemorySources, memorySourceSchema } from "./research-briefing";
import { SignInLink } from "./sign-in-link";

const recordedCase = z.object({
  platform: z.enum(["kalshi", "polymarket"]),
  nativeId: z.string().min(1),
  runId: z.string(),
  pickId: z.string(),
  pickVersion: z.number().int().positive(),
  recordedAt: z.string(),
  status: z.enum(["supported", "contradicted", "unclear"]),
  explanation: z.string(),
  sources: z.array(memorySourceSchema).max(100),
});
const habitSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(["repeated_claims", "insufficient_history"]),
  reviewedCases: z.number().int().nonnegative(),
  patterns: z
    .array(
      z.object({
        normalizedClaim: z.string(),
        cases: z.array(recordedCase).max(20),
      }),
    )
    .max(20),
  method: z.string(),
  historyLimit: z.number().int().positive(),
});

export function HabitReview() {
  const [data, setData] = useState<z.infer<typeof habitSchema> | null>(null);
  const [error, setError] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/review/habits", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 401) {
          if (!controller.signal.aborted) setSignedOut(true);
          return;
        }
        if (!response.ok) throw new Error("Review unavailable");
        const result = habitSchema.parse(await response.json());
        if (!controller.signal.aborted) setData(result);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Your history review is unavailable right now.");
      });
    return () => controller.abort();
  }, []);
  const patterns =
    data?.patterns.filter(
      (pattern) =>
        new Set(
          pattern.cases.map((item) =>
            JSON.stringify([item.platform, item.nativeId]),
          ),
        ).size >= 2,
    ) ?? [];
  return (
    <section className="page narrow" aria-label="Reasoning history review">
      <div className="panel">
        <h2>Across your picks</h2>
        <p className="small muted">
          Repeated claims are a starting point for reflection. They do not
          establish a habit or prove poor reasoning.
        </p>
        {signedOut ? (
          <p>
            <SignInLink>Sign in to review your history</SignInLink>
          </p>
        ) : error ? (
          <p role="status">{error}</p>
        ) : !data ? (
          <p role="status">Loading recorded reviews…</p>
        ) : (
          <>
            <p className="small muted">
              {data.reviewedCases} distinct market(s) reviewed, from up to{" "}
              {data.historyLimit} recent saved reviews. Matching uses identical
              claims after normalizing case and spacing.
            </p>
            {!patterns.length ? (
              <p>
                No repeated claim across at least two distinct markets was
                found. More reviews may help; a single case is not a pattern.
              </p>
            ) : (
              patterns.map((pattern) => (
                <details key={pattern.normalizedClaim}>
                  <summary>
                    {pattern.normalizedClaim} ·{" "}
                    {
                      new Set(
                        pattern.cases.map(
                          (item) => `${item.platform}:${item.nativeId}`,
                        ),
                      ).size
                    }{" "}
                    markets
                  </summary>
                  {pattern.cases.map((item) => (
                    <article
                      key={`${item.platform}:${item.nativeId}:${item.runId}`}
                    >
                      <p>
                        <Link
                          href={`${liveMarketPath({ platform: item.platform, id: item.nativeId })}#run-${encodeURIComponent(item.runId)}`}
                        >
                          {item.nativeId}
                        </Link>{" "}
                        · pick v{item.pickVersion}
                      </p>
                      <p className="small">
                        Recorded interpretation: {item.status}.{" "}
                        {item.explanation}
                      </p>
                      <MemorySources sources={item.sources} />
                    </article>
                  ))}
                </details>
              ))
            )}
            <p className="small muted">
              This read-only review does not save preferences or change picks.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
