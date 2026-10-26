import { agentAvailability } from "../../../../lib/server/agent-service";
import { getCurrentUser } from "../../../../lib/server/auth";
export const runtime = "nodejs";
export async function GET() {
  const status = agentAvailability();
  try {
    const user = status.accountConfigured ? await getCurrentUser() : null;
    return Response.json(
      { ...status, authenticated: !!user, userId: user?.id ?? null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        ...status,
        authenticated: false,
        userId: null,
        error: "ACCOUNT_UNAVAILABLE",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
