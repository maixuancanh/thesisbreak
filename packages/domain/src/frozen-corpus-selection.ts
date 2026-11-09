import { createHash } from "node:crypto";
type Entry = { id: string; family: string; split: string; sha256: string };
type Manifest = { corpusSha256: string; cases: Entry[] };
type Options = {
  split?: "dev" | "validation" | "sealed-test" | "all_unsealed";
  allowSealed?: boolean;
  limit: number;
  offset?: number;
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
/** Validate the complete frozen inventory before selecting a bounded execution batch. */
export function selectFrozenCases(
  raw: string,
  manifest: Manifest,
  options: Options,
): Record<string, unknown>[] {
  if (digest(raw) !== manifest.corpusSha256)
    throw Error("CORPUS_HASH_MISMATCH");
  const offset = options.offset ?? 0,
    split = options.split ?? "dev";
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0
  )
    throw Error("INVALID_BATCH");
  if (split === "sealed-test" && !options.allowSealed)
    throw Error("SEALED_OPT_IN_REQUIRED");
  const rows = raw
    .trim()
    .split("\n")
    .map((line) => ({
      line,
      row: JSON.parse(line) as Record<string, unknown>,
    }));
  const ids = new Set<string>(),
    members = new Map<string, Entry>(),
    families = new Map<string, string>();
  for (const m of manifest.cases) {
    if (members.has(m.id)) throw Error("DUPLICATE_MANIFEST_ID");
    if (!["dev", "validation", "sealed-test"].includes(m.split))
      throw Error("UNKNOWN_SPLIT");
    if (families.has(m.family) && families.get(m.family) !== m.split)
      throw Error("FAMILY_SPLIT_LEAKAGE");
    families.set(m.family, m.split);
    members.set(m.id, m);
  }
  for (const { line, row } of rows) {
    if (typeof row.id !== "string" || ids.has(row.id))
      throw Error("DUPLICATE_CASE_ID");
    ids.add(row.id);
    const m = members.get(row.id);
    if (!m) throw Error("MANIFEST_MEMBERSHIP_MISMATCH");
    if (digest(line) !== m.sha256) throw Error("CASE_HASH_MISMATCH");
    if (typeof row.family === "string" && row.family !== m.family)
      throw Error("CASE_FAMILY_MISMATCH");
  }
  if (ids.size !== members.size) throw Error("MANIFEST_MEMBERSHIP_MISMATCH");
  return rows
    .filter(({ row }) => {
      const s = members.get(row.id as string)!.split;
      return split === "all_unsealed" ? !s.startsWith("sealed") : s === split;
    })
    .slice(offset, offset + options.limit)
    .map(({ row }) => row);
}
