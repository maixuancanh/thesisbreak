import { authConfigured, getCurrentUser } from "../../../../lib/server/auth";
export const runtime = "nodejs";
export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  if (!authConfigured())
    return Response.json(
      { configured: false, authenticated: false },
      { status: 503, headers },
    );
  try {
    const user = await getCurrentUser();
    return Response.json(
      { configured: true, authenticated: Boolean(user), userId: user?.id ?? null },
      { headers },
    );
  } catch {
    return Response.json(
      { configured: true, authenticated: false, error: "AUTH_UNAVAILABLE" },
      { status: 503, headers },
    );
  }
}
