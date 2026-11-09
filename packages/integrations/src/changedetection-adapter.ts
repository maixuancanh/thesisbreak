import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
import { z } from "zod";
import { sourceSnapshotSchema, type SourceSnapshot } from "../../domain/src/source-watch";

export function validatePublisherUrl(raw: string, hosts: readonly string[]) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || isIP(url.hostname) || !hosts.includes(url.hostname.toLowerCase())) throw Error("SOURCE_URL_FORBIDDEN");
  return url;
}
/** Conservative global-unicast policy. DNS answers are pinned to the socket lookup. */
export function isPublicSourceAddress(ip: string) {
  if (isIP(ip) === 6) return /^[23][0-9a-f]{3}:/i.test(ip) && !/^2001:(?:db8|0|10|20):/i.test(ip) && !/^2002:/i.test(ip);
  if (isIP(ip) !== 4) return false;
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
}
export async function fetchSourceText(raw: string, hosts: readonly string[], headers: Record<string, string> = {}, redirects = 0): Promise<{ text: string; contentType: string }> {
  const url = validatePublisherUrl(raw, hosts);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !isPublicSourceAddress(a.address))) throw Error("SOURCE_ADDRESS_FORBIDDEN");
  const pinned = addresses[0]!;
  return new Promise((resolve, reject) => {
    const req = request(url, { headers, signal: AbortSignal.timeout(10000), lookup: (_host, _options, cb) => cb(null, pinned.address, pinned.family) }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        if (redirects >= 2 || !res.headers.location) return reject(Error("SOURCE_REDIRECT_LIMIT"));
        const next = new URL(res.headers.location, url);
        // Never forward service authentication to another origin.
        if (next.origin !== url.origin && Object.keys(headers).length) return reject(Error("SOURCE_AUTH_REDIRECT_FORBIDDEN"));
        fetchSourceText(next.href, hosts, headers, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(Error("SOURCE_HTTP_FAILED")); return; }
      let bytes = 0;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 262144) { res.destroy(Error("SOURCE_BODY_TOO_LARGE")); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), contentType: String(res.headers["content-type"] ?? "") }));
    });
    req.on("error", reject);
    req.end();
  });
}
export const sourceWatchNotificationSchema = z.object({
  schemaVersion: z.literal(1), serviceWatchId: z.string().min(1).max(200),
  timestamp: z.string().datetime(), nonce: z.string().min(16).max(100),
}).strict();
/** Relay signs the exact bytes. Owner, source URL and snapshots cannot come from the caller. */
export function verifySourceWatchNotification(body: string, signature: string, secret: string, now = Date.now()) {
  if (Buffer.byteLength(body) > 4096 || secret.length < 32 || !/^[a-f0-9]{64}$/.test(signature)) throw Error("INVALID_SOURCE_SIGNATURE");
  const expected = createHmac("sha256", secret).update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw Error("INVALID_SOURCE_SIGNATURE");
  const event = sourceWatchNotificationSchema.parse(JSON.parse(body));
  if (Math.abs(now - Date.parse(event.timestamp)) > 300000) throw Error("SOURCE_NOTIFICATION_EXPIRED");
  return event;
}
/** Reads authenticated upstream history; local binding supplies event identity, never the webhook. */
export async function readChangedetectionSnapshot(input: {
  baseUrl: string; apiKey: string; serviceWatchId: string; hosts: readonly string[];
  binding: Omit<SourceSnapshot, "value" | "publishedAt"> & { selector: string };
  fetchText?: typeof fetchSourceText;
}) {
  const base = validatePublisherUrl(input.baseUrl, input.hosts);
  if (!input.apiKey) throw Error("SOURCE_SERVICE_AUTH_REQUIRED");
  const read = async (path: string) => (input.fetchText ?? fetchSourceText)(new URL(path, base).href, input.hosts, { "x-api-key": input.apiKey });
  const path = `/api/v1/watch/${encodeURIComponent(input.serviceWatchId)}`;
  const metadata = JSON.parse((await read(path)).text) as { url?: string; include_filters?: unknown; paused?: boolean };
  if (metadata.url !== input.binding.url || metadata.paused === true || !Array.isArray(metadata.include_filters) || !metadata.include_filters.includes(input.binding.selector)) throw Error("SOURCE_SERVICE_BINDING_MISMATCH");
  const history = JSON.parse((await read(`${path}/history`)).text) as unknown;
  if (!history || Array.isArray(history) || typeof history !== "object") throw Error("SOURCE_HISTORY_INVALID");
  const timestamps = Object.keys(history).filter((k) => /^\d{1,12}(?:\.\d+)?$/.test(k)).sort((a,b) => Number(a) - Number(b));
  const latest = timestamps.at(-1);
  if (!latest || Number(latest)*1000 > Date.now()+300000) throw Error("SOURCE_HISTORY_EMPTY_OR_FUTURE");
  const after = await read(`${path}/history/${encodeURIComponent(latest)}`);
  const beforeTimestamp = timestamps.at(-2);
  const before = beforeTimestamp ? await read(`${path}/history/${encodeURIComponent(beforeTimestamp)}`) : null;
  const { selector: _selector, ...identity } = input.binding;
  void _selector;
  return {
    snapshot: sourceSnapshotSchema.parse({ ...identity, value: after.text, publishedAt: null }),
    beforeValue: before?.text ?? null,
    observedAt: new Date(Number(latest)*1000).toISOString(),
  };
}
