/** Read-only release gate. Passing build does not substitute for these live checks. */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { Pool } from "pg";
import { readMemoryInventory } from "../packages/db/src/memory-recovery";
type Gate = { name: string; status: "pass" | "pending"; detail: string };
const gates: Gate[] = [];
const record = (name: string, passed: boolean, detail: string) =>
  gates.push({ name, status: passed ? "pass" : "pending", detail });
let pool: Pool | undefined;
try {
  record(
    "production.origin",
    /^https:\/\//.test(process.env.APP_URL ?? ""),
    "APP_URL must use the deployed HTTPS origin",
  );
  record(
    "production.model_endpoint",
    /^https:\/\//.test(process.env.LLM_BASE_URL ?? ""),
    "Loopback gateway is development-only",
  );
  record(
    "tatum.configuration",
    !!process.env.TATUM_API_KEY &&
      !!process.env.TATUM_SUI_RPC_URL &&
      !!process.env.MEMWAL_OWNER_ADDRESS,
    "Configuration presence only; a live Tatum proof is still required",
  );
  let distinct = 0,
    usable = 0;
  if (process.env.DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const users = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE provider_subject LIKE 'google:%'",
    );
    for (const user of users.rows) {
      const inventory = await readMemoryInventory(pool, user.id);
      distinct += inventory.summary.verifiedDistinctLessons;
      usable += inventory.summary.rejectedRecords
        ? 0
        : inventory.summary.verifiedDistinctLessons;
    }
  }
  record(
    "memory.receipts",
    usable >= 10,
    `${distinct} distinct verified preferences in Google accounts. Demo records must still be excluded by human audit; versions/retries are not counted twice`,
  );
  const proof = ".local/recovery-proof.json";
  let recovery = false;
  if (existsSync(proof)) {
    try {
      recovery =
        JSON.parse(readFileSync(proof, "utf8")).completeness ===
        "expected_inventory_verified";
    } catch {}
  }
  record(
    "acceptance.recovery",
    recovery,
    "Local acceptance namespace only; production restore remains separate",
  );
  record(
    "production.browser_journey",
    false,
    "Needs hosted sign-in, chat, pick, lesson reuse, pause, watch and outage evidence",
  );
  let publicNews = false;
  try {
    const news = JSON.parse(
      readFileSync(".local/independent-sources-proof.json", "utf8"),
    );
    const checks = news.proof.flatMap(
      (p: { sources: { source: string; state: string; records: number }[] }) =>
        p.sources,
    );
    publicNews = [
      "nba-official",
      "fed-official",
      "team-official:lakers",
      "team-official:jazz",
    ].every((source) =>
      checks.some(
        (c: { source: string; state: string; records: number }) =>
          c.source === source && c.state === "available" && c.records > 0,
      ),
    );
  } catch {}
  record(
    "independent.public_sources",
    publicNews,
    "Local recorded public-source acceptance only; hosted checks and broader market mapping remain separate",
  );
  record(
    "independent.general_assumption_evaluation",
    false,
    "Named-player NBA status watches are implemented; general news/event assumption evaluation remains pending",
  );
  record(
    "submission.materials",
    false,
    "Public repository, hosted demo, blog and video URLs need final verification",
  );
  console.log(
    JSON.stringify(
      { ready: gates.every((g) => g.status === "pass"), gates },
      null,
      2,
    ),
  );
  if (gates.some((g) => g.status !== "pass")) process.exitCode = 2;
} catch {
  console.log(JSON.stringify({ ready: false, error: "READINESS_UNAVAILABLE" }));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
