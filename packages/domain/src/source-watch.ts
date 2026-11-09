import { createHash } from "node:crypto";
import { z } from "zod";

export const sourceWatchInputSchema = z.object({
  eventId: z.string().min(1).max(300),
  url: z.string().url().max(2000),
  originId: z.string().min(1).max(300),
  contentClass: z.enum(["json", "feed", "html"]),
  // JSON pointer, feed field or changedetection selector; never executable code.
  selector: z.string().min(1).max(500),
  dependencyId: z.string().min(1).max(300),
  hypothesisVersion: z.number().int().positive(),
  eventEndAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  pollSeconds: z.number().int().min(300).max(86400).default(300),
}).strict();
export type SourceWatchInput = z.input<typeof sourceWatchInputSchema>;
export const sourceSnapshotSchema = z.object({
  eventId: z.string().min(1), originId: z.string().min(1), url: z.string().url(),
  contentClass: z.enum(["json", "feed", "html"]),
  value: z.string().max(262144), publishedAt: z.string().datetime().nullable(),
}).strict();
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
/** Hash only the explicitly watched value, never page headers, ads, or timestamps. */
export function sourceSnapshotHash(value: string) {
  return createHash("sha256").update(value.normalize("NFC").replace(/\r\n/g, "\n").trim()).digest("hex");
}
export function sourceJsonPointer(raw: unknown, pointer: string): string {
  if (!pointer.startsWith("/") || pointer.length > 500) throw Error("INVALID_JSON_POINTER");
  let value = raw;
  for (const segment of pointer.slice(1).split("/")) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (["__proto__", "constructor", "prototype"].includes(key) || !value || typeof value !== "object" || !Object.hasOwn(value, key)) throw Error("WATCH_FIELD_MISSING");
    value = (value as Record<string, unknown>)[key];
  }
  // Scalar watched fields keep noise outside the field out of the comparison.
  if (!["string", "number", "boolean"].includes(typeof value) && value !== null) throw Error("WATCH_FIELD_NOT_SCALAR");
  return typeof value === "string" ? value : JSON.stringify(value);
}
