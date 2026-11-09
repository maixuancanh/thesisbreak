import "server-only";
import { reportServiceFailure } from "./service-failure";
import { Pool } from "pg";
import { z } from "zod";
import { requireUser, assertMutationOrigin, AuthError } from "./auth";
import { boundedJson } from "./bounded-json";
import {
  inspectResearchArtifact,
  grantResearchArtifactConsent,
  revokeResearchArtifactConsent,
  listResearchArtifactConsent,
} from "../../../../packages/db/src/research-artifact-consent";
let pool: Pool | undefined;
function database() {
  if (!process.env.DATABASE_URL)
    throw new AuthError(503, "DATABASE_NOT_CONFIGURED");
  return (pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    allowExitOnIdle: true,
  }));
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const operationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("inspect"),
      kind: z.enum([
        "source_change",
        "forecast_rationale",
        "forecast_result",
        "drift_summary",
        "decision_recap",
        "accountability_review",
      ]),
      artifactId: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal("grant"),
      inspectionId: z.uuid(),
      snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
      confirmed: z.literal(true),
    })
    .strict(),
  z.object({ action: z.literal("revoke"), grantId: z.uuid() }).strict(),
]);
export async function researchArtifactConsentOperation(request: Request) {
  try {
    const user = await requireUser();
    if (request.method === "GET")
      return json(await listResearchArtifactConsent(database(), user.id));
    assertMutationOrigin(request);
    const input = operationSchema.parse(await boundedJson(request, 4096));
    if (input.action === "inspect")
      return json(
        await inspectResearchArtifact(
          database(),
          user.id,
          input.kind,
          input.artifactId,
        ),
      );
    if (input.action === "revoke")
      return (await revokeResearchArtifactConsent(
        database(),
        user.id,
        input.grantId,
      ))
        ? json({ revoked: true })
        : json({ error: "NOT_FOUND" }, 404);
    const grant = await grantResearchArtifactConsent(
      database(),
      user.id,
      input,
    );
    return json(
      {
        id: grant.id,
        consentedAt: grant.consented_at,
        snapshotHash: grant.snapshot_hash,
        state: "consented",
      },
      201,
    );
  } catch (error) {
    if (error instanceof AuthError)
      return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return json({ error: "INVALID_INPUT" }, 400);
    const code = error instanceof Error ? error.message : "";
    if (
      [
        "INSPECTION_NOT_AVAILABLE",
        "RESEARCH_ARTIFACT_SNAPSHOT_CHANGED",
        "CONSENT_REVOKED",
      ].includes(code)
    )
      return json({ error: code }, 409);
    if (
      [
        "RESEARCH_ARTIFACT_NOT_AVAILABLE",
        "OFFICIAL_RESULT_REQUIRED",
        "ORIGINAL_FORECAST_REQUIRED",
        "NON_MEANINGFUL_SOURCE_CHANGE",
        "MEANINGFUL_DRIFT_SUMMARY_REQUIRED",
        "DRIFT_RESULT_HASH_MISMATCH",
      ].includes(code)
    )
      return json({ error: "ARTIFACT_NOT_AVAILABLE" }, 404);
    reportServiceFailure("artifact", error);
    return json({ error: "ARTIFACT_CONSENT_UNAVAILABLE" }, 503);
  }
}
