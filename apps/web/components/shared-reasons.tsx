"use client";
import { PagedList } from "./paged-list";
import Link from "next/link";
import { z } from "zod";
import {
  sharedResponse,
  safeEvidenceUrl,
  type PickReview,
} from "../lib/pick-review-client";
export function SharedReasons({
  data,
  reviews,
}: {
  data: z.infer<typeof sharedResponse>;
  reviews: PickReview[];
}) {
  return (
    <section className="reason-section">
      <h2>Shared reasons</h2>
      <p className="muted">See which picks rely on the same report.</p>
      {data.items.length ? (
        <PagedList items={data.items} label="Shared reasons" size={5}>
          {(g) => (
            <article key={g.familyId} className="panel">
              <h3>
                {g.pickCount} {g.pickCount === 1 ? "pick relies" : "picks rely"}{" "}
                on the same report
              </h3>
              <p className="small muted">
                {g.originStatus === "verified"
                  ? "Shared report origin verified"
                  : "Origin not confirmed."}
              </p>
              {safeEvidenceUrl(g.sourceUrl) && (
                <a
                  className="text-link"
                  href={safeEvidenceUrl(g.sourceUrl)!}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View report ↗
                </a>
              )}
              <ul>
                {g.pickIds.map((pickId, i) => (
                  <li key={pickId}>
                    <Link className="text-link" href={`/picks#pick-${pickId}`}>
                      {reviews.find((r) => r.pickId === pickId)?.question ??
                        `Affected pick ${i + 1}`}
                    </Link>
                  </li>
                ))}
              </ul>
            </article>
          )}
        </PagedList>
      ) : (
        <p className="muted">No shared report has been identified yet.</p>
      )}
    </section>
  );
}
