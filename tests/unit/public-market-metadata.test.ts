import { describe, expect, it } from "vitest";
import { PublicCatalog } from "../../packages/integrations/src/public-catalog";
const market = { ticker:"KXTEST-26-A",event_ticker:"KXTEST-26",title:"Will A score over 2.5 goals?",last_price_dollars:"0.42",volume_fp:"10",occurrence_datetime:"2026-10-24T19:45:00Z",close_time:"2026-10-26T19:45:00Z",rules_primary:"Above 2.5 goals after regular time" };
function client(overrides: Record<string, unknown> = {}) {
  return new PublicCatalog(async url => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/metadata")) return Response.json({image_url:"https://assets.kalshi.com/event.webp",competition:"Conference League",competition_scope:"Team Total",market_details:[{market_ticker:"OTHER",image_url:"https://assets.kalshi.com/wrong.webp"},{market_ticker:market.ticker,image_url:"https://assets.kalshi.com/team.webp"}],...overrides});
    if(path.includes("/events/")) return Response.json({event:{event_ticker:market.event_ticker,title:"A vs B: Team Total",category:"Sports"}});
    return Response.json({events:[{event_ticker:market.event_ticker,markets:[market]}]});
  });
}
describe("sourced event presentation metadata",()=>{
 it("uses exact market artwork, sourced competition and occurrence time distinct from close",async()=>{
  const row=(await client().list("kalshi",20)).data[0]!;
  expect(row).toMatchObject({category:"Sports",competition:"Conference League",marketScope:"Team Total",imageUrl:"https://assets.kalshi.com/team.webp",scheduledAt:market.occurrence_datetime,closeTime:market.close_time});
 });
 it("never takes another contract artwork or arbitrary remote URLs",async()=>{
  const row=(await client({image_url:"https://evil.example/track.png",market_details:[{market_ticker:"OTHER",image_url:"https://assets.kalshi.com/wrong.webp"}]}).list("kalshi",20)).data[0]!;
  expect(row.imageUrl).toBeNull();
 });
 it("retains usable market when optional metadata fails, without deriving start from close",async()=>{
  const row=(await new PublicCatalog(async url => new URL(String(url)).pathname.includes("/events/") ? new Response("unavailable",{status:503}):Response.json({events:[{event_ticker:market.event_ticker,markets:[{...market,occurrence_datetime:undefined}]}]})).list("kalshi",20)).data[0]!;
  expect(row.scheduledAt).toBeNull();expect(row.imageUrl).toBeNull();expect(row.category).toBeNull();expect(row.question).toBe(market.title);
 });
 it("rejects a nested market assigned to a different event",async()=>{
  await expect(new PublicCatalog(async()=>Response.json({events:[{event_ticker:"WRONG",markets:[market]}]})).list("kalshi",20)).rejects.toThrow("INVALID_PROVIDER_RESPONSE");
 });
 it("keeps valid optional identity and artwork when a schedule is invalid",async()=>{
  const row=(await new PublicCatalog(async()=>Response.json([{id:"1",conditionId:`0x${"a".repeat(64)}`,question:"A?",outcomes:'["Yes","No"]',outcomePrices:'["0.6","0.39"]',gameStartTime:"unknown",events:[{id:"42",title:"A vs B",category:"Sports"}]}])).list("polymarket",20)).data[0]!;
  expect(row.eventId).toBe("42");expect(row.scheduledAt).toBeNull();
 });
 it("normalizes explicit UTC offsets in Gamma schedules without discarding event context",async()=>{
  const row=(await new PublicCatalog(async()=>Response.json([{id:"1",conditionId:`0x${"a".repeat(64)}`,question:"A?",outcomes:'["Yes","No"]',outcomePrices:'["0.6","0.39"]',gameStartTime:"2026-10-24 19:45:00+00",events:[{id:"42",title:"A vs B"}]}])).list("polymarket",20)).data[0]!;
  expect(row.eventId).toBe("42");expect(row.scheduledAt).toBe("2026-10-24T19:45:00+00:00");
 });
 it("uses only future active NBA contracts in the labelled featured selection",async()=>{
  const future={...market,status:"active",occurrence_datetime:"2099-01-01T00:00:00Z"};
  const c=new PublicCatalog(async url=>{
    const u=new URL(String(url));
    if(u.pathname.endsWith("/events")) {expect(u.searchParams.get("series_ticker")).toBe("KXNBAGAME");return Response.json({events:[{event_ticker:market.event_ticker,series_ticker:"KXNBAGAME",markets:[future,{...future,ticker:"KXOLD",occurrence_datetime:"2000-01-01T00:00:00Z"},{...future,ticker:"KXCLOSED",status:"finalized"}]}]});}
    return new Response("unavailable",{status:503});
  });
  const rows=await c.featuredSports();expect(rows.map(m=>m.id)).toEqual([market.ticker]);
 });
 it("accepts official decimal-strike ticker identities without changing them",async()=>{
 const id="KXGDPYEAR-36-T0.1";
 const row=(await new PublicCatalog(async url=>String(url).includes("/markets/") ? Response.json({market:{...market,ticker:id}}):new Response("unavailable",{status:503})).get("kalshi",id)).data[0]!;
 expect(row.id).toBe(id);
 });
 it("preserves embedded Polymarket event identity and does not use end date as kickoff",async()=>{
  const row=(await new PublicCatalog(async()=>Response.json([{id:"1",conditionId:`0x${"a".repeat(64)}`,question:"A to win?",outcomes:'["Yes","No"]',outcomePrices:'["0.6","0.39"]',endDate:"2026-10-26T19:45:00Z",gameStartTime:"2026-10-24T19:45:00Z",image:"https://polymarket-upload.s3.us-east-2.amazonaws.com/team.png",events:[{id:"42",title:"A vs B",category:"Sports"}]}])).list("polymarket",20)).data[0]!;
  expect(row).toMatchObject({eventId:"42",eventTitle:"A vs B",category:"Sports",scheduledAt:"2026-10-24T19:45:00Z"});
 });
});
