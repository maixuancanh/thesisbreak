import { z } from "zod";
const text = z.string().trim().min(1).max(1000).nullish();
const timestamp = z.unknown().transform(value => {
  if(typeof value !== "string") return null;
  const normalized=value.replace(/^(\d{4}-\d{2}-\d{2}) /,"$1T").replace(/([+-]\d{2})$/,"$1:00");
  return z.iso.datetime({offset:true}).safeParse(normalized).success ? normalized : null;
});
export type Presentation = { category:string|null; competition:string|null; marketScope:string|null; scheduledAt:string|null; imageUrl:string|null; conditionLabel?:string|null; mutuallyExclusive?:boolean|null };
export function trustedMarketImage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (!["assets.kalshi.com", "polymarket-upload.s3.us-east-2.amazonaws.com", "images.polymarket.com"].includes(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}
export function marketPresentation(value: unknown, platform: "kalshi"|"polymarket"): Presentation & {eventId:string|null;eventTitle:string|null} {
  const empty = {conditionLabel:null,mutuallyExclusive:null,category:null,competition:null,marketScope:null,scheduledAt:null,imageUrl:null,eventId:null,eventTitle:null};
  if (platform === "kalshi") {
    const row=z.object({occurrence_datetime:timestamp,yes_sub_title:text}).safeParse(value);
    return {...empty,conditionLabel:row.success ? row.data.yes_sub_title ?? null : null,scheduledAt:row.success ? row.data.occurrence_datetime ?? null : null};
  }
  const row=z.object({gameStartTime:timestamp,image:z.unknown().optional(),events:z.array(z.object({id:z.union([z.string(),z.number().int()]),title:text,category:text})).optional()}).safeParse(value);
  if(!row.success) return empty;
  // Multiple attached events are ambiguous: retain native market identity without choosing one.
  const event=row.data.events?.length === 1 ? row.data.events[0] : undefined;
  return {...empty,scheduledAt:row.data.gameStartTime ?? null,imageUrl:trustedMarketImage(row.data.image),eventId:event ? String(event.id):null,eventTitle:event?.title ?? null,category:event?.category ?? null};
}
export const eventSchema = z.object({event:z.object({event_ticker:z.string(),title:z.string().min(1).max(1000),mutually_exclusive:z.boolean().optional(),category:text,product_metadata:z.object({competition:text,competition_scope:text}).nullish()})});
export const eventArtworkSchema = z.object({image_url:z.unknown().optional(),competition:text,competition_scope:text,market_details:z.array(z.object({market_ticker:z.string(),image_url:z.unknown().optional()})).optional()});
export type EventPresentation = {mutuallyExclusive:boolean|null; title:string;category:string|null;competition:string|null;marketScope:string|null;imageUrl:string|null;marketImages:Map<string,string|null>};
