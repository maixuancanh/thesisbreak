// Local development infrastructure only. Credentials never enter console output.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parse } from "dotenv";
const root = process.cwd(),
  base = resolve(root, ".local"),
  pg = resolve(base, "postgres"),
  bin = "C:/Program Files/PostgreSQL/16/bin";
mkdirSync(base, { recursive: true });
const passwordFile = resolve(base, "postgres.password");
if (!existsSync(passwordFile))
  writeFileSync(passwordFile, randomBytes(32).toString("hex"), { mode: 0o600 });
const password = readFileSync(passwordFile, "utf8").trim();
function run(name, args, allowed = [0]) {
  const r = spawnSync(`${bin}/${name}.exe`, args, {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, PGPASSWORD: password },
    timeout: 45000,
  });
  if (!allowed.includes(r.status))
    throw new Error(`Local PostgreSQL ${name} failed (output withheld)`);
  return r;
}
if (!existsSync(resolve(pg, "PG_VERSION")))
  run("initdb", [
    "-D",
    pg,
    "-U",
    "thesisbreak",
    `--pwfile=${passwordFile}`,
    "--auth=scram-sha-256",
    "--encoding=UTF8",
    "--locale=C",
  ]);
const running = run("pg_ctl", ["-D", pg, "status"], [0, 3]);
if (running.status !== 0)
  run("pg_ctl", [
    "-D",
    pg,
    "-l",
    resolve(base, "postgres.log"),
    "-o",
    "-h 127.0.0.1 -p 55453",
    "-w",
    "start",
  ]);
for (const name of ["thesisbreak", "thesisbreak_test"]) {
  const query = run("psql", [
    "-h",
    "127.0.0.1",
    "-p",
    "55453",
    "-U",
    "thesisbreak",
    "-d",
    "postgres",
    "-tAc",
    `SELECT 1 FROM pg_database WHERE datname='${name}'`,
  ]);
  if (!query.stdout.trim())
    run("createdb", [
      "-h",
      "127.0.0.1",
      "-p",
      "55453",
      "-U",
      "thesisbreak",
      name,
    ]);
}
const envPath = resolve(root, ".env"),
  env = parse(readFileSync(envPath, "utf8"));
env.DATABASE_URL = `postgresql://thesisbreak:${password}@127.0.0.1:55453/thesisbreak`;
env.TEST_DATABASE_URL = `postgresql://thesisbreak:${password}@127.0.0.1:55453/thesisbreak_test`;
writeFileSync(
  envPath,
  Object.entries(env)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join("\n") + "\n",
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    postgres: "ready",
    port: 55453,
    databases: ["thesisbreak", "thesisbreak_test"],
    configuration: ".env",
    secretsLogged: false,
  }),
);
