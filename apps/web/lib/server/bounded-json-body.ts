import { AuthError } from "./auth";

/** Cap actual bytes while streaming, before buffering or parsing JSON. */
export async function boundedJsonBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, "INVALID_JSON");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16384) {
        await reader.cancel();
        throw new AuthError(413, "BODY_TOO_LARGE");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AuthError(400, "INVALID_JSON");
  }
}
