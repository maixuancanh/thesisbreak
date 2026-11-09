/** Node-only database TLS bootstrap. */
export async function configureDatabaseCertificate() {
  if (!process.env.DATABASE_CA_CERT || !process.env.DATABASE_URL) return;
  const { writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const certificate = process.env.DATABASE_CA_CERT;
  if (!certificate.includes("-----BEGIN CERTIFICATE-----"))
    throw Error("INVALID_DATABASE_CA");
  const path = join(tmpdir(), "thesisbreak-database-ca.crt");
  await writeFile(path, certificate, { mode: 0o600 });
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert", path);
  process.env.DATABASE_URL = url.toString();
}
