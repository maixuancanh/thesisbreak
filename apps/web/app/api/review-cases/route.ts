import { reviewCasesOperation } from "../../../lib/server/review-case-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return reviewCasesOperation(request);
}
