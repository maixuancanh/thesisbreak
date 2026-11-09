/** Read-only diagnostics. This command never writes memories or sends transactions. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envFile = resolve(process.cwd(), ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

type Status = "PASS" | "FAIL" | "BLOCKED";
type Check = { name: string; status: Status; detail: string };
const checks: Check[] = [];
const configured = (name: string) => Boolean(process.env[name]?.trim());
function record(name: string, status: Status, detail: string) {
  checks.push({ name, status, detail });
}

async function requestJson(url: URL, init: RequestInit = {}): Promise<unknown> {
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(url.hostname)
  ) {
    throw new Error("Provider URLs must use HTTPS outside localhost");
  }
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function probe(name: string, action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    // Provider bodies, URLs and exception messages can contain credentials.
    const safe =
      error instanceof Error && /^HTTP \d{3}$/.test(error.message)
        ? error.message
        : "Request failed or response did not match the expected shape";
    record(name, "FAIL", safe);
  }
}

async function main() {
  if (configured("TATUM_API_KEY")) {
    for (const platform of ["polymarket", "kalshi"]) {
      await probe(`tatum.catalog.${platform}`, async () => {
        const url = new URL("https://api.tatum.io/v4/data/prediction/markets");
        url.searchParams.set("platform", platform);
        url.searchParams.set("limit", "1");
        const body = await requestJson(url, {
          headers: { "x-api-key": process.env.TATUM_API_KEY! },
        });
        // Capture no market payload until the live schema is reviewed in the adapter.
        if (body === null || typeof body !== "object")
          throw new Error("Invalid JSON");
        record(
          `tatum.catalog.${platform}`,
          "PASS",
          "Authenticated JSON response received; market normalization and coverage still require adapter verification",
        );
      });
    }
  } else record("tatum.catalog", "BLOCKED", "TATUM_API_KEY is missing");

  if (configured("TATUM_SUI_RPC_URL") && configured("MEMWAL_ACCOUNT_ID")) {
    await probe("tatum.sui.account", async () => {
      const body = (await requestJson(new URL(process.env.TATUM_SUI_RPC_URL!), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(configured("TATUM_API_KEY")
            ? { "x-api-key": process.env.TATUM_API_KEY! }
            : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sui_getObject",
          params: [
            process.env.MEMWAL_ACCOUNT_ID,
            { showType: true, showOwner: true },
          ],
        }),
      })) as {
        error?: unknown;
        result?: { data?: { objectId?: string }; error?: unknown };
      };
      if (body.error || body.result?.error || !body.result?.data?.objectId)
        throw new Error("Object missing");
      if (
        body.result.data.objectId.toLowerCase() !==
        process.env.MEMWAL_ACCOUNT_ID!.toLowerCase()
      ) {
        throw new Error("Object mismatch");
      }
      record(
        "tatum.sui.account",
        "PASS",
        "Configured object returned by configured RPC; ownership policy and network require separate verification",
      );
    });
  } else
    record(
      "tatum.sui.account",
      "BLOCKED",
      "TATUM_SUI_RPC_URL or MEMWAL_ACCOUNT_ID is missing",
    );

  record(
    "walrus.mainnet.roundtrip",
    "BLOCKED",
    configured("MEMWAL_ACCOUNT_ID") && configured("MEMWAL_DELEGATE_KEY")
      ? "Credentials present; SDK adapter and explicit Mainnet roundtrip must be verified separately"
      : "MEMWAL_ACCOUNT_ID or MEMWAL_DELEGATE_KEY is missing",
  );
  record(
    "llm.generation",
    "BLOCKED",
    configured("LLM_API_KEY") && configured("LLM_MODEL")
      ? "Credentials present; model adapter generation has not been verified"
      : "LLM_API_KEY or LLM_MODEL is missing",
  );
  record(
    "database.migration",
    "BLOCKED",
    configured("DATABASE_URL")
      ? "DATABASE_URL present; run migration and integration tests separately"
      : "DATABASE_URL is missing",
  );
  record(
    "football.source",
    "BLOCKED",
    "No licensed source adapter and event mapping have been verified",
  );
  console.log(JSON.stringify({ readOnly: true, checks }, null, 2));
  process.exitCode = checks.some((check) => check.status === "FAIL")
    ? 1
    : checks.some((check) => check.status === "BLOCKED")
      ? 2
      : 0;
}

void main().catch(() => {
  console.error(
    "Provider diagnostics could not run. No credential values were printed.",
  );
  process.exitCode = 1;
});
