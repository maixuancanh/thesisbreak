import { Pool } from "pg";
import { verifySourceWatchNotification } from "../../../../../../packages/integrations/src/changedetection-adapter";
import { acceptSourceWatchWebhook } from "../../../../../../packages/integrations/src/source-watch";
import { sourceWatchConfig } from "../../../../../../packages/integrations/src/source-watch-config";
export const runtime = "nodejs";
export const maxDuration = 60;
let pool: Pool | undefined;
export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  const secret = process.env.SOURCE_WATCH_WEBHOOK_SECRET ?? "";
  const signature = request.headers.get("x-source-signature") ?? "";
  if (secret.length < 32 || !/^[a-f0-9]{64}$/.test(signature))
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers });
  const reader = request.body?.getReader();
  if (!reader)
    return Response.json({ error: "INVALID_INPUT" }, { status: 400, headers });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        return Response.json(
          { error: "BODY_TOO_LARGE" },
          { status: 413, headers },
        );
      }
      chunks.push(part.value);
    }
  } catch {
    return Response.json({ error: "INVALID_INPUT" }, { status: 400, headers });
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks).toString("utf8");
  try {
    verifySourceWatchNotification(body, signature, secret);
  } catch {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers });
  }
  const config = sourceWatchConfig();
  if (!config.enabled)
    return Response.json({ status: "disabled" }, { headers });
  try {
    if (!process.env.DATABASE_URL) throw Error("DATABASE_UNAVAILABLE");
    pool ??= new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3,
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
      allowExitOnIdle: true,
    });
    return Response.json(
      await acceptSourceWatchWebhook(pool, body, signature, secret, config),
      { headers },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "SOURCE_NOTIFICATION_REPLAY"
    )
      return Response.json(
        { error: "SOURCE_NOTIFICATION_REPLAY" },
        { status: 409, headers },
      );
    return Response.json(
      { error: "SOURCE_WATCH_UNAVAILABLE" },
      { status: 503, headers },
    );
  }
}
