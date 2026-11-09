import "dotenv/config";
import { Pool } from "pg";
import {
  auditStrengthening,
  reportOutputPath,
  writePrivateReport,
} from "../packages/db/src/strengthening-audit";
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const match = /^--(user|output)=(.+)$/.exec(a);
    if (!match) throw Error("EXPLICIT_OWNER_AND_PRIVATE_OUTPUT_REQUIRED");
    return [match[1], match[2]];
  }),
);
if (!args.user || !args.output || !process.env.DATABASE_URL)
  throw Error("EXPLICIT_OWNER_AND_PRIVATE_OUTPUT_REQUIRED");
reportOutputPath(args.output);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 10000,
  statement_timeout: 20000,
});
try {
  const report = await auditStrengthening(pool, args.user, process.env);
  const file = await writePrivateReport(args.output, report);
  console.log(
    JSON.stringify({
      kind: report.kind,
      ...file,
      readOnly: true,
      benefitDemonstrated: false,
    }),
  );
} catch {
  console.error("STRENGTHENING_AUDIT_FAILED");
  process.exitCode = 1;
} finally {
  await pool.end();
}
