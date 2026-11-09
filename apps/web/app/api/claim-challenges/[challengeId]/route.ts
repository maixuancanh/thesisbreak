import { claimChallengeRequest } from "../../../../lib/server/claim-challenge-service";
export const runtime = "nodejs";
type Context = { params: Promise<{ challengeId: string }> };
export async function GET(request: Request, context: Context) {
  return claimChallengeRequest(request, (await context.params).challengeId);
}
export async function PATCH(request: Request, context: Context) {
  return claimChallengeRequest(request, (await context.params).challengeId);
}
