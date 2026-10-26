import { recoveryOperation } from "../../../../lib/server/recovery-service";
export const runtime = "nodejs";
export const GET = (request: Request) => recoveryOperation(request);
export const POST = (request: Request) => recoveryOperation(request, true);
