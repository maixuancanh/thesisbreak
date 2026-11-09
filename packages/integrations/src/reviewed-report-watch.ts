import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { recordSourceWatchSnapshot } from "../../db/src/source-watches";
import { recordSourceLineage } from "../../db/src/source-lineage";
export type ReviewedReportTarget = {
  reportId: string;
  claimId: string;
  eventId: string;
  subjectId: string;
};
const reportSchema = z
  .object({
    reportId: z.string().min(1).max(300),
    claimId: z.string().min(1).max(300),
    eventId: z.string().min(1).max(300),
    subjectId: z.string().min(1).max(300),
    status: z.enum(["original", "corrected", "withdrawn"]),
    content: z.string().max(32000),
    citations: z.array(z.url().max(2000)).max(20).default([]),
    publishedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  })
  .strict();
/** A registered publisher's exact report identity and status fields establish revision semantics. */
export async function recordReviewedReportSnapshot(
  pool: Pool,
  userId: string,
  watchId: string,
  raw: unknown,
  target: ReviewedReportTarget,
) {
  const report = reportSchema.parse(raw);
  if (
    report.reportId !== target.reportId ||
    report.claimId !== target.claimId ||
    report.eventId !== target.eventId ||
    report.subjectId !== target.subjectId
  )
    throw Error("REPORT_IDENTITY_MISMATCH");
  const watch = (
    await pool.query(
      "SELECT * FROM source_watches WHERE id=$1 AND user_id=$2",
      [watchId, userId],
    )
  ).rows[0];
  if (!watch || watch.event_id !== report.eventId)
    throw Error("REPORT_WATCH_MISMATCH");
  const value = JSON.stringify(report),
    sourceHash = createHash("sha256").update(value).digest("hex");
  const result = await recordSourceWatchSnapshot(
    pool,
    userId,
    watchId,
    {
      eventId: report.eventId,
      originId: watch.origin_id,
      url: watch.url,
      contentClass: watch.content_class,
      value,
      publishedAt: report.publishedAt,
    },
    {
      structuredEvidence: {
        subjectId: report.subjectId,
        claimId: report.claimId,
        eventId: report.eventId,
        official: false,
        revision: report.status,
        sourceUrl: watch.url,
        sourceHash,
        adapterVersion: "reviewed-report-revision-v1",
      },
    },
  );
  // Never fetch citation URLs. Only already registered same-owner, same-event reports can join a family.
  const related = (
    await pool.query(
      "SELECT id,url FROM source_watches WHERE user_id=$1 AND event_id=$2 AND id<>$3 AND url=ANY($4::text[]) AND structured_evidence->>'claimId'=$5 AND structured_evidence->>'subjectId'=$6",
      [
        userId,
        report.eventId,
        watchId,
        report.citations,
        report.claimId,
        report.subjectId,
      ],
    )
  ).rows;
  for (const cited of related)
    await recordSourceLineage(pool, userId, {
      id: randomUUID(),
      fromEvidenceId: watchId,
      toEvidenceId: cited.id,
      relation: "explicit_citation",
      verification: "verified",
      supportRef: watchId,
      supportHash: sourceHash,
      version: 1,
    });
  return result;
}
