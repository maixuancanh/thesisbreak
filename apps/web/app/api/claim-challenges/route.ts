import { claimChallengeRequest } from "../../../lib/server/claim-challenge-service";
export const runtime = "nodejs";
export const POST = (request: Request) => claimChallengeRequest(request);

export const GET = (request: Request) => claimChallengeRequest(request);
