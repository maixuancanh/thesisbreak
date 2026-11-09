import { sourceWatchOperation } from "../../../../lib/server/source-watch-service";
export const runtime = "nodejs";
export async function PATCH(
  request: Request,
  context: { params: Promise<{ watchId: string }> },
) {
  return sourceWatchOperation(
    request,
    "update",
    (await context.params).watchId,
  );
}
