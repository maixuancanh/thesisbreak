import "dotenv/config";
import { Pool } from "pg";
import {
  cohortExportOptions,
  exportForecastCohort,
  reportOutputPath,
  writePrivateReport,
} from "../packages/db/src/strengthening-audit";
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const match = /^--(user|namespace|method|horizon|asOf|output)=(.+)$/.exec(
      a,
    );
    if (!match) throw Error("EXPLICIT_COHORT_OPTIONS_REQUIRED");
    return [match[1], match[2]];
  }),
);
const { output, ...selection } = args;
if (!output || !process.env.DATABASE_URL)
  throw Error("DATABASE_AND_PRIVATE_OUTPUT_REQUIRED");
reportOutputPath(output);
const input = cohortExportOptions.parse(selection);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 10000,
  statement_timeout: 20000,
});
try {
  const report = await exportForecastCohort(pool, input);
  const file = await writePrivateReport(output, report);
  console.log(
    JSON.stringify({
      kind: report.kind,
      counts: report.counts,
      ...file,
      readOnly: true,
    }),
  );
} catch {
  console.error("FORECAST_COHORT_EXPORT_FAILED");
  process.exitCode = 1;
} finally {
  await pool.end();
}
