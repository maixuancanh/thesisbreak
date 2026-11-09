import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { selectFrozenCases } from "../../packages/domain/src/frozen-corpus-selection";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const rows = [
  { id: "a", family: "one" },
  { id: "b", family: "two" },
  { id: "c", family: "three" },
];
const raw = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const manifest = {
  corpusSha256: digest(raw),
  cases: rows.map((r, i) => ({
    ...r,
    split: ["dev", "validation", "sealed-test"][i]!,
    sha256: digest(JSON.stringify(r)),
  })),
};
it("selects a bounded offset batch without exposing sealed rows by default", () => {
  expect(
    selectFrozenCases(raw, manifest, { limit: 2, offset: 0 }).map((r) => r.id),
  ).toEqual(["a"]);
  expect(
    selectFrozenCases(raw, manifest, {
      split: "validation",
      limit: 2,
      offset: 0,
    }).map((r) => r.id),
  ).toEqual(["b"]);
  expect(() =>
    selectFrozenCases(raw, manifest, {
      split: "sealed-test",
      limit: 2,
      offset: 0,
    }),
  ).toThrow("SEALED_OPT_IN_REQUIRED");
  expect(
    selectFrozenCases(raw, manifest, {
      split: "sealed-test",
      allowSealed: true,
      limit: 1,
      offset: 0,
    })[0]?.id,
  ).toBe("c");
  expect(
    selectFrozenCases(raw, manifest, {
      split: "all_unsealed",
      limit: 1,
      offset: 1,
    })[0]?.id,
  ).toBe("b");
});
it("rejects tampered per-case hashes, unknown members, duplicate ids and split family leakage", () => {
  expect(() =>
    selectFrozenCases(
      raw,
      {
        ...manifest,
        cases: manifest.cases.map((r, i) =>
          i === 0 ? { ...r, sha256: "0".repeat(64) } : r,
        ),
      },
      { limit: 1 },
    ),
  ).toThrow("CASE_HASH_MISMATCH");
  expect(() =>
    selectFrozenCases(
      raw,
      { ...manifest, cases: manifest.cases.slice(1) },
      { limit: 1 },
    ),
  ).toThrow("MANIFEST_MEMBERSHIP_MISMATCH");
  const duplicate =
    JSON.stringify(rows[0]) + "\n" + JSON.stringify(rows[0]) + "\n";
  expect(() =>
    selectFrozenCases(
      duplicate,
      { corpusSha256: digest(duplicate), cases: [manifest.cases[0]!] },
      { limit: 1 },
    ),
  ).toThrow("DUPLICATE_CASE_ID");
  expect(() =>
    selectFrozenCases(
      raw,
      {
        ...manifest,
        cases: manifest.cases.map((r, i) =>
          i === 1 ? { ...r, family: "one" } : r,
        ),
      },
      { limit: 1 },
    ),
  ).toThrow("FAMILY_SPLIT_LEAKAGE");
});
