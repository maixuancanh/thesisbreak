import { sourceWatchOperation } from "../../../lib/server/source-watch-service";
export const runtime = "nodejs";
export const GET = (request: Request) => sourceWatchOperation(request, "list");
export const POST = (request: Request) =>
  sourceWatchOperation(request, "create");
