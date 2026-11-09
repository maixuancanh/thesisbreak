import { AgentWorkspace } from "../../components/agent-workspace";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    platform?: string;
    id?: string;
    provider?: string;
    session?: string;
  }>;
}) {
  const query = await searchParams;
  return (
    <AgentWorkspace
      initialPlatform={
        query.platform === "polymarket" ? "polymarket" : "kalshi"
      }
      initialId={query.id ?? ""}
      initialSessionId={query.session}
      provider={query.provider === "tatum" ? "tatum" : "public"}
    />
  );
}
