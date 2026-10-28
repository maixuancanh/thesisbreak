import "server-only";
import type {} from "./auth-types";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { getServerSession, type NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import {
  AuthError,
  authConfigured,
  resolveIdentity,
  withAuthAvailability,
  trackAuthBackend,
} from "./auth-policy";
export { assertMutationOrigin, AuthError, authConfigured } from "./auth-policy";
const maxAge = 60 * 60 * 24 * 7;
let pool: Pool | undefined;
function database() {
  if (!authConfigured()) throw new AuthError(503, "AUTH_NOT_CONFIGURED");
  return (pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    allowExitOnIdle: true,
  }));
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function lookupIdentity(subject: string, sid: string) {
  const result = await database().query<{ id: string }>(
    `SELECT u.id FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.token_hash=$2 AND s.revoked_at IS NULL AND s.expires_at>NOW()`,
    [subject, hash(sid)],
  );
  return result.rows[0] ?? null;
}
export function authOptions(
  reportFailure: () => void = () => {},
): NextAuthOptions {
  if (!authConfigured()) throw new AuthError(503, "AUTH_NOT_CONFIGURED");
  process.env.NEXTAUTH_URL = process.env.APP_URL!;
  return {
    secret: process.env.AUTH_SECRET!,
    useSecureCookies: process.env.APP_URL!.startsWith("https:"),
    providers: [
      GoogleProvider({
        clientId: process.env.AUTH_GOOGLE_ID!,
        clientSecret: process.env.AUTH_GOOGLE_SECRET!,
      }),
    ],
    pages: { signIn: "/account", error: "/account" },
    session: { strategy: "jwt", maxAge },
    callbacks: {
      async jwt({ token, account, profile }) {
        if (account) {
          if (
            account.provider !== "google" ||
            !account.providerAccountId ||
            profile?.sub !== account.providerAccountId
          )
            throw new AuthError(401, "INVALID_PROVIDER_SUBJECT");
          const subject = `google:${account.providerAccountId}`;
          const user = await database().query<{ id: string }>(
            `INSERT INTO users (id, provider_subject) VALUES ($1,$2) ON CONFLICT (provider_subject) DO UPDATE SET provider_subject=EXCLUDED.provider_subject RETURNING id`,
            [randomUUID(), subject],
          );
          const id = user.rows[0]!.id;
          const sid = randomBytes(32).toString("base64url");
          await database().query(
            `INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)`,
            [randomUUID(), id, hash(sid), new Date(Date.now() + maxAge * 1000)],
          );
          return { sub: id, sid };
        }
        return token;
      },
      async session({ session, token }) {
        const user = await trackAuthBackend(
          () => resolveIdentity(token, lookupIdentity),
          reportFailure,
        );
        // NextAuth's session endpoint returns no user for revoked/expired rows.
        return {
          expires: session.expires,
          ...(user ? { user: { id: user.id } } : {}),
        };
      },
      async redirect({ url }) {
        const origin = process.env.APP_URL!;
        if (url.startsWith("/") && !url.startsWith("//")) return origin + url;
        try {
          if (new URL(url).origin === origin) return url;
        } catch {
          /* reject invalid URLs */
        }
        return origin + "/account";
      },
    },
    events: {
      async signOut(message) {
        if ("token" in message && typeof message.token?.sid === "string")
          await trackAuthBackend(
            () =>
              database().query(
                `UPDATE sessions SET revoked_at=NOW() WHERE token_hash=$1`,
                [hash(message.token.sid as string)],
              ),
            reportFailure,
          );
      },
    },
  };
}
export async function getCurrentUser() {
  if (!authConfigured()) throw new AuthError(503, "AUTH_NOT_CONFIGURED");
  const session = await withAuthAvailability((reportFailure) =>
    getServerSession(authOptions(reportFailure)),
  );
  const user = session?.user as { id?: string } | undefined;
  return user?.id ? { id: user.id } : null;
}
export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) throw new AuthError(401, "UNAUTHENTICATED");
  return user;
}
