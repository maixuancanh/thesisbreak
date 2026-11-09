import { notFound } from "next/navigation";
import { LiveMarketDetail } from "../../../../components/live-market-detail";
import { livePlatform, liveProvider } from "../../../../lib/live-market";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ platform: string; id: string }>;
  searchParams: Promise<{ provider?: string | string[] }>;
}) {
  const { platform, id } = await params;
  const { provider } = await searchParams;
  const source =
    provider === undefined ? undefined : liveProvider.safeParse(provider);
  if (source && !source.success) notFound();
  const parsed = livePlatform.safeParse(platform);
  if (!parsed.success || !id) notFound();
  return (
    <LiveMarketDetail
      key={`${platform}:${id}:${source?.data ?? "auto"}`}
      platform={parsed.data}
      id={id}
      provider={source?.data}
    />
  );
}
