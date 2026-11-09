import { learningCandidateOperation } from "../../../../../lib/server/learning-service";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ candidateId: string }> },
) {
  const { candidateId } = await context.params;
  return learningCandidateOperation(request, candidateId);
}
