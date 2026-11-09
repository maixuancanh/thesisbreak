import { learningCandidateOperation } from "../../../../lib/server/learning-service";
export const runtime = "nodejs";
export const GET = (request: Request) => learningCandidateOperation(request);
