import { readFile, writeFile } from "node:fs/promises";
import { usefulMemoryInventory } from "../packages/domain/src/useful-memory-inventory";
const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw Error(
    "Usage: audit-useful-memory-inventory.ts reviewed-inventory.json report.json",
  );
const rows: unknown = JSON.parse(await readFile(input, "utf8"));
if (!Array.isArray(rows)) throw Error("INVENTORY_ARRAY_REQUIRED");
const report = usefulMemoryInventory(rows);
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(report));
