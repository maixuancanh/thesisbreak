"use client";
import { usePickReviewEnabled } from "./pick-review-feature";
import { useEffect, useState } from "react";
import { z } from "zod";
import { ExplanationStatus } from "./explanation-status";
import { explanationReferenceSchema } from "../../../packages/domain/src/explanation-review";
import { Button } from "./ui/button";
import { friendlyDate } from "../lib/live-market";
import { safeEvidenceUrl } from "../lib/pick-review-client";
const recapSchema = z.object({
  id: z.string(),
  revision: z.number(),
  initialReason: z.object({
    text: z.string(),
    pickVersion: z.number(),
    outcome: z.string(),
    confirmedAt: z.string(),
  }),
  changes: z.array(
    z.object({
      id: z.string(),
      explanation: z.string(),
      conditionMet: z.boolean().nullable(),
      checkedAt: z.string(),
      publishedAt: z.string().nullable().optional(),
      observedAt: z.string().nullable().optional(),
    }),
  ),
  choices: z.array(
    z.object({
      id: z.string(),
      action: z.string(),
      confirmedAt: z.string(),
      afterEvent: z.boolean().nullable(),
    }),
  ),
  officialResult: z.object({
    status: z.enum(["waiting", "final", "not_scored"]),
    winner: z.string().nullable(),
    pickWon: z.boolean().nullable(),
    sourceUrl: z.string().nullable(),
    observedAt: z.string().nullable(),
  }),
  conditionOccurred: z.boolean().nullable(),
  eventStartedAt: z.string().nullable(),
  recordedAt: z.string(),
  explanationReview: explanationReferenceSchema.optional(),
});
function DecisionRecapEnabled({
  pickId,
  embedded = false,
}: {
  pickId: string;
  embedded?: boolean;
}) {
  const [data, setData] = useState<z.infer<typeof recapSchema> | null>(null),
    [open, setOpen] = useState(embedded),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open) return;
    const c = new AbortController();
    setLoading(true);
    setError("");
    void fetch(`/api/picks/${encodeURIComponent(pickId)}/recap`, {
      cache: "no-store",
      signal: c.signal,
    })
      .then(async (r) => {
        if (!r.ok)
          throw Error("Your decision recap is unavailable. Try again.");
        const value = await r.json();
        if (!c.signal.aborted)
          setData(value.recap ? recapSchema.parse(value.recap) : null);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError((e as Error).message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [pickId, open, reload]);
  return (
    <section className="decision-recap">
      {!embedded && (
        <Button
          variant="outline"
          aria-expanded={open}
          onClick={() => setOpen((x) => !x)}
        >
          {open ? "Close recap" : "After the event · View recap"}
        </Button>
      )}
      {open && (
        <div className="panel">
          <h3>Your decision recap</h3>
          {loading ? (
            <p role="status">Loading chronology…</p>
          ) : error ? (
            <div role="alert">
              <p>{error}</p>
              <Button variant="outline" onClick={() => setReload((x) => x + 1)}>
                Retry
              </Button>
            </div>
          ) : !data ? (
            <p>Waiting for a verified event result and decision chronology.</p>
          ) : (
            <>
              <p className="small muted">
                Revision {data.revision} · Recorded{" "}
                {friendlyDate(data.recordedAt)}
              </p>
              <h4>Initial reason</h4>
              <p>
                {data.initialReason.outcome} ·{" "}
                {data.initialReason.text || "No confirmed reason recorded"}
              </p>
              <p className="small muted">
                Confirmed {friendlyDate(data.initialReason.confirmedAt)} · Pick
                version {data.initialReason.pickVersion}
              </p>
              <h4>What changed</h4>
              {data.changes.length ? (
                data.changes.map((c) => (
                  <p key={c.id}>
                    {c.explanation}
                    <span className="small muted">
                      {" "}
                      · Published {friendlyDate(c.publishedAt)} · Observed{" "}
                      {friendlyDate(c.observedAt)} · Checked{" "}
                      {friendlyDate(c.checkedAt)}
                    </span>
                  </p>
                ))
              ) : (
                <p>No source changes recorded.</p>
              )}
              <h4>What you chose</h4>
              {data.choices.length ? (
                data.choices.map((c) => (
                  <p key={c.id}>
                    {c.action === "keep"
                      ? "Kept the pick"
                      : c.action === "update"
                        ? "Updated the view"
                        : c.action === "stop_watching"
                          ? "Stopped watching"
                          : c.action}{" "}
                    · {friendlyDate(c.confirmedAt)}
                    {c.afterEvent === true
                      ? " · After the event started"
                      : c.afterEvent === null
                        ? " · Event timing unknown"
                        : ""}
                  </p>
                ))
              ) : (
                <p>No review decision recorded.</p>
              )}
              <h4>Official result</h4>
              {data.officialResult.status === "final" && (
                <p>Result confirmed</p>
              )}
              <ExplanationStatus
                status={data.explanationReview?.status ?? "not_assessed"}
              />
              <p className="small muted">
                Event started: {friendlyDate(data.eventStartedAt)} · Result
                observed: {friendlyDate(data.officialResult.observedAt)}
              </p>
              <p>
                {data.officialResult.status === "waiting"
                  ? "Waiting for the official result."
                  : data.officialResult.status === "not_scored"
                    ? "Not scored. This event or pick does not have an eligible result."
                    : (data.officialResult.winner ?? "Result unavailable")}
              </p>
              <dl>
                <dt>Did the condition occur?</dt>
                <dd>
                  {data.conditionOccurred === null
                    ? "Not established"
                    : data.conditionOccurred
                      ? "Yes"
                      : "No"}
                </dd>
                <dt>Did the pick win?</dt>
                <dd>
                  {data.officialResult.pickWon === null
                    ? "Not scored"
                    : data.officialResult.pickWon
                      ? "Yes"
                      : "No"}
                </dd>
              </dl>
              {safeEvidenceUrl(data.officialResult.sourceUrl) && (
                <a
                  className="text-link"
                  href={safeEvidenceUrl(data.officialResult.sourceUrl)!}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View official result ↗
                </a>
              )}
              <p className="small muted">
                A winning pick does not establish that its reason was correct. A
                losing pick does not establish that its reason was wrong.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

export function DecisionRecap(
  props: Parameters<typeof DecisionRecapEnabled>[0],
) {
  return usePickReviewEnabled() ? <DecisionRecapEnabled {...props} /> : null;
}
