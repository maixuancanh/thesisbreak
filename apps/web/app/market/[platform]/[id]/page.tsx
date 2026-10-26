import { MarketDetail } from "../../../../components/preview";
import { markets } from "../../../../lib/catalog";
import { notFound } from "next/navigation";
export default async function Page({
  params,
}: {
  params: Promise<{ platform: string; id: string }>;
}) {
  const { platform, id } = await params;
  const market = markets.find(
    (m) => m.platform.toLowerCase() === platform && m.id === id,
  );
  if (!market) notFound();
  return <MarketDetail m={market} />;
}
