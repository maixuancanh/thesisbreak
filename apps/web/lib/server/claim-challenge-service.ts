import "server-only";
import { z } from "zod";
import { requireUser, assertMutationOrigin, AuthError } from "./auth";
import { boundedJsonBody } from "./bounded-json-body";
import { sessionDb } from "./chat-session-service";
import {
  readClaimChallenge,
  listMessageClaimChallenges,
  submitClaimChallenge,
  withdrawClaimChallenge,
} from "../../../../packages/db/src/claim-challenges";
import {
  createChallengeVerifier,
  runOneClaimChallengeJob,
} from "../../../../packages/integrations/src/claim-challenge-worker";
import { after } from "next/server";
export function challengeError(error: unknown) {
  const message =
    error instanceof Error ? error.message : "CHALLENGE_UNAVAILABLE";
  const status =
    error instanceof AuthError
      ? error.status
      : error instanceof z.ZodError
        ? 422
        : message === "NOT_FOUND"
          ? 404
          : [
                "REQUEST_ID_REUSED",
                "REVISION_CONFLICT",
                "CHALLENGE_CLOSED",
                "CLAIM_TEXT_MISMATCH",
              ].includes(message)
            ? 409
            : 503;
  return Response.json(
    {
      error:
        status === 503
          ? "CHALLENGE_UNAVAILABLE"
          : error instanceof z.ZodError
            ? "INVALID_INPUT"
            : message,
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
export async function claimChallengeRequest(request: Request, id?: string) {
  try {
    if (request.method !== "GET") assertMutationOrigin(request);
    const user = await requireUser();
    if (process.env.THESISBREAK_ACCOUNTABILITY_ENABLED !== "true") {
      if (request.method === "GET" && !id)
        return Response.json(
          { claims: [], challenges: [] },
          { headers: { "Cache-Control": "no-store" } },
        );
      throw new AuthError(503, "CLAIM_CHALLENGE_DISABLED");
    }
    if (request.method === "GET" && !id) {
      const messageId = z
        .string()
        .min(1)
        .max(300)
        .parse(new URL(request.url).searchParams.get("messageId"));
      return Response.json(
        await listMessageClaimChallenges(sessionDb(), user.id, messageId),
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (request.method === "GET" && id)
      return Response.json(await readClaimChallenge(sessionDb(), user.id, id), {
        headers: { "Cache-Control": "no-store" },
      });
    if (request.method === "PATCH" && id)
      return Response.json(
        await withdrawClaimChallenge(
          sessionDb(),
          user.id,
          id,
          await boundedJsonBody(request),
        ),
      );
    const saved = await submitClaimChallenge(
      sessionDb(),
      user.id,
      await boundedJsonBody(request),
    );
    after(async () => {
      try {
        await runOneClaimChallengeJob(sessionDb(), {
          ownerId: user.id,
          hosts: (process.env.SOURCE_WATCH_PUBLISHER_HOSTS ?? "")
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
          verify: createChallengeVerifier(process.env),
        });
      } catch {
        /* Durable job retains bounded retries. */
      }
    });
    return Response.json(saved, {
      status: 202,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return challengeError(error);
  }
}
