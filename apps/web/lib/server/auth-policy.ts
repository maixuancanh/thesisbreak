export type AuthEnvironment = Record<string, string | undefined>;
export function authConfigured(env: AuthEnvironment = process.env) {
  try {
    const url = new URL(env.APP_URL ?? "");
    return Boolean(
      env.AUTH_GOOGLE_ID &&
      env.AUTH_GOOGLE_SECRET &&
      env.AUTH_SECRET &&
      env.AUTH_SECRET.length >= 32 &&
      env.DATABASE_URL &&
      url.origin === env.APP_URL &&
      (url.protocol === "https:" ||
        (env.NODE_ENV !== "production" && url.hostname === "localhost")),
    );
  } catch {
    return false;
  }
}
export function assertMutationOrigin(
  request: Request,
  appUrl = process.env.APP_URL,
) {
  if (!appUrl || request.headers.get("origin") !== appUrl)
    throw new AuthError(403, "ORIGIN_FORBIDDEN");
}
export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type InternalIdentity = { id: string };
export async function resolveIdentity(
  token: { sub?: unknown; sid?: unknown } | null,
  lookup: (
    subject: string,
    sessionId: string,
  ) => Promise<InternalIdentity | null>,
): Promise<InternalIdentity | null> {
  if (typeof token?.sub !== "string" || typeof token.sid !== "string")
    return null;
  return lookup(token.sub, token.sid);
}

// The installed NextAuth engine deliberately catches callback/event failures.
// Retain that request's availability signal outside the engine's result.
export async function withAuthAvailability<T>(
  operation: (reportFailure: () => void) => Promise<T>,
): Promise<T> {
  let failed = false;
  const value = await operation(() => {
    failed = true;
  });
  if (failed) throw new AuthError(503, "AUTH_UNAVAILABLE");
  return value;
}
export async function trackAuthBackend<T>(
  operation: () => Promise<T>,
  reportFailure: () => void,
): Promise<T> {
  try {
    return await operation();
  } catch {
    reportFailure();
    throw new AuthError(503, "AUTH_UNAVAILABLE");
  }
}
