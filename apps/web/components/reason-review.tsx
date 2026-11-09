"use client";
import { useState } from "react";
import type { ResearchResult } from "../lib/agent-client";
import { LessonReview } from "./lesson-review";
import { Button } from "./ui/button";
const labels = {
  supported: "Supported by supplied evidence",
  contradicted: "Conflicts with supplied evidence",
  unclear: "Still unclear",
};
export function ReasonReview({
  result,
  runId,
  domain,
  competition,
}: {
  result: ResearchResult;
  runId: string;
  domain: string;
  competition?: string;
}) {
  const [draft, setDraft] = useState(false);
  const review = result.reply.reasonReview,
    after = result.reply.retrospective,
    outcome = result.outcomeReview;
  function citations(refs: string[]) {
    return refs.map((id) => {
      const source = result.sources.find((s) => s.id === id);
      return source?.url ? (
        <a key={id} href={source.url} target="_blank" rel="noreferrer">
          View evidence
        </a>
      ) : null;
    });
  }
  return (
    <>
      {review && (
        <section className="agent-suggestion">
          <h3>Does your reason still hold?</h3>
          <p className="small muted">
            Review of saved view v{review.baseVersion} · Agent interpretation
            for you to assess
          </p>
          <p>{review.summary}</p>
          {review.claims.map((claim, i) => (
            <article key={i}>
              <strong>{labels[claim.status]}</strong>
              <p>{claim.claim}</p>
              <p className="small">{claim.explanation}</p>
              <div className="row">{citations(claim.evidenceRefs)}</div>
            </article>
          ))}
          <p className="small muted">
            Current evidence does not show what was known when you made the
            pick. This review does not change your view.
          </p>
        </section>
      )}
      {outcome && (
        <section className="agent-suggestion">
          <h3>Result & reasoning</h3>
          <p>
            Final result: <strong>{outcome.outcome}</strong>. Your saved choice:{" "}
            {outcome.pickedOutcome}.
          </p>
          <p>
            {outcome.comparison === "matched"
              ? "Your choice matched the result."
              : outcome.comparison === "did_not_match"
                ? "Your choice did not match the result."
                : "This version was saved after the result, so it is not scored."}
          </p>
          <p className="small muted">
            A matching result alone does not prove good reasoning.
          </p>
          <div className="row">{citations([outcome.sourceRef])}</div>
          {after && (
            <>
              <p>{after.summary}</p>
              <div className="row">{citations(after.evidenceRefs)}</div>
              {after.reasoningLesson && (
                <>
                  <h4>Possible lesson for next time</h4>
                  <p>{after.reasoningLesson}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setDraft((x) => !x)}
                  >
                    {draft ? "Close lesson draft" : "Review lesson draft"}
                  </Button>
                  {draft && (
                    <LessonReview
                      key={runId}
                      initialRule={after.reasoningLesson}
                      domain={domain}
                      {...(competition ? { competition } : {})}
                      sourceRunId={runId}
                    />
                  )}
                </>
              )}
            </>
          )}
        </section>
      )}
    </>
  );
}
