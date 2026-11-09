import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parse } from "dotenv";
import { Pool } from "pg";
// Read-only export. Does not change source, destination or deployed environment.
const sourceFile =
  process.argv.find((a) => a.startsWith("--source-env="))?.slice(13) ??
  ".local/production-runtime.env";
const url = parse(await readFile(sourceFile)).DATABASE_URL;
if (!url) throw Error("SOURCE_DATABASE_REQUIRED");
const source = new URL(url);
if (!["postgres:", "postgresql:"].includes(source.protocol))
  throw Error("POSTGRES_REQUIRED");
const pool = new Pool({
  connectionString: url,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
  max: 1,
});
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = resolve(".local/backups", stamp);
await mkdir(dir, { recursive: true });
try {
  const state = (
    await pool.query(
      "SELECT current_setting('server_version_num')::int AS version,pg_database_size(current_database())::text AS bytes",
    )
  ).rows[0];
  const tool =
    process.env.PG_DUMP_PATH ??
    "C:/Program Files/PostgreSQL/16/bin/pg_dump.exe";
  const toolVersion = spawnSync(tool, ["--version"], { encoding: "utf8", windowsHide: true });
  const toolMajor = Number(toolVersion.stdout?.match(/PostgreSQL\) (\d+)/)?.[1]);
  if (toolVersion.status !== 0 || !Number.isInteger(toolMajor) || toolMajor < Math.floor(state.version / 10000))
    throw Error("MATCHING_NEWER_PG_DUMP_REQUIRED");
  const file = resolve(dir, "thesisbreak.dump");
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    PGHOST: source.hostname,
    PGPORT: source.port || "5432",
    PGDATABASE: decodeURIComponent(source.pathname.slice(1)),
    PGUSER: decodeURIComponent(source.username),
    PGPASSWORD: decodeURIComponent(source.password),
    PGSSLMODE: source.searchParams.get("sslmode") ?? "verify-full",
    ...(source.searchParams.get("sslrootcert") ? { PGSSLROOTCERT: source.searchParams.get("sslrootcert")! } : {}),
    PGCONNECT_TIMEOUT: "10",
  };
  // Application namespaces only: Supabase's own auth/storage schemas must remain separate.
  await new Promise<void>((ok, fail) => {
    const p = spawn(
      tool,
      [
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--schema=public",
        "--schema=drizzle",
        "--file",
        file,
      ],
      {
        env,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    p.stderr.resume();
    const timer = setTimeout(() => {
      p.kill();
      fail(Error("BACKUP_TIMEOUT"));
    }, 300000);
    p.on("error", () => {
      clearTimeout(timer);
      fail(Error("BACKUP_TOOL_UNAVAILABLE"));
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) ok();
      else fail(Error("BACKUP_FAILED"));
    });
  });
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  const size = (await stat(file)).size;
  if (!size) throw Error("EMPTY_BACKUP");
  const report = {
    createdAt: new Date().toISOString(),
    format: "pg_custom",
    schemas: ["public", "drizzle"],
    sha256: h.digest("hex"),
    dumpBytes: size,
    sourceDatabaseBytes: state.bytes,
    sourceVersion: state.version,
    readOnly: true,
    restored: false,
    cutover: false,
  };
  await writeFile(
    resolve(dir, "manifest.json"),
    JSON.stringify(report, null, 2),
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      status: "backed_up",
      directory: dir,
      sha256: report.sha256,
      restored: false,
      cutover: false,
    }),
  );
} catch (error) {
  const code = (error as { code?: string }).code;
  await writeFile(
    resolve(dir, "failure.json"),
    JSON.stringify({
      at: new Date().toISOString(),
      code: code === "53000" ? "SOURCE_QUOTA_BLOCKED" : "EXPORT_FAILED",
      cutover: false,
    }),
  );
  console.error(
    code === "53000"
      ? "SOURCE_QUOTA_BLOCKED_NO_EXPORT"
      : "EXPORT_FAILED_NO_CUTOVER",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
