/** A minimal public readiness response. Never expose settings or caught errors. */
export async function deploymentReadiness(
  env: Record<string, string | undefined>,
  checkDatabase: () => Promise<unknown>,
): Promise<{ status: "ready" | "unavailable" }> {
  const required = [
    "DATABASE_URL",
    "AUTH_SECRET",
    "AUTH_GOOGLE_ID",
    "AUTH_GOOGLE_SECRET",
    "LLM_API_KEY",
    "LLM_MODEL",
    "MEMWAL_ACCOUNT_ID",
    "MEMWAL_DELEGATE_KEY",
  ];
  if (required.some((key) => !env[key]?.trim()))
    return { status: "unavailable" };
  try {
    for (const value of [env.APP_URL, env.LLM_BASE_URL]) {
      const url = new URL(value ?? "");
      if (url.protocol !== "https:" || url.username || url.password)
        return { status: "unavailable" };
    }
    await checkDatabase();
    return { status: "ready" };
  } catch {
    return { status: "unavailable" };
  }
}
