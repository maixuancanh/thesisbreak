import { pickOperation } from "../../../lib/server/pick-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return pickOperation(request, "list");
}
export function POST(request: Request) {
  return pickOperation(request, "create");
}
