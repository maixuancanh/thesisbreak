/** Fixed-source transport: callers own the hostname/path allowlist, never browser input. */
export async function boundedRead(
  url: string,
  allowedHosts: readonly string[],
  options: { transport?: typeof fetch; maxBytes?: number } = {},
) {
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    !allowedHosts.includes(target.hostname) ||
    target.port ||
    target.username ||
    target.password
  )
    throw new Error("SOURCE_NOT_ALLOWED");
  const response = await (options.transport ?? fetch)(target, {
    redirect: "error",
    signal: AbortSignal.timeout(12000),
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403
        ? "SOURCE_ACCESS_REQUIRED"
        : response.status === 429
          ? "SOURCE_RATE_LIMITED"
          : "SOURCE_UNAVAILABLE",
    );
  const max = options.maxBytes ?? 2_000_000;
  if (Number(response.headers.get("content-length")) > max)
    throw new Error("SOURCE_TOO_LARGE");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SOURCE_EMPTY");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > max) {
        await reader.cancel();
        throw new Error("SOURCE_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks));
}
