import { monitorOperation } from "../../../lib/server/monitor-service";
export const runtime = "nodejs";
export const GET = (request: Request) => monitorOperation(request, "list");
export const POST = (request: Request) => monitorOperation(request, "create");
export const PATCH = (request: Request) => monitorOperation(request, "control");
