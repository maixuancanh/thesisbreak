import { expect,it } from "vitest";
import { decideResearchReadiness } from "../../packages/domain/src/decision-quality";
const now="2026-10-27T10:00:00Z";
it("distinguishes a successful empty observation from an unavailable lookup",()=>{
  expect(decideResearchReadiness([{id:"a",status:"observed",asOf:now,changed:false}],now)).toMatchObject({decision:"wait",reason:"no_change",checks:[{id:"a",state:"observed_no_change"}]});
  expect(decideResearchReadiness([{id:"a",status:"unavailable",asOf:null,changed:false}],now)).toMatchObject({decision:"wait",reason:"incomplete_coverage",checks:[{id:"a",state:"unavailable"}]});
});
it("never treats stale or future observations as usable evidence",()=>{
  const r=decideResearchReadiness([{id:"a",status:"observed",asOf:"2026-10-27T09:00:00Z",changed:true},{id:"b",status:"observed",asOf:"2026-10-27T10:01:00Z",changed:true}],now);
  expect(r.decision).toBe("wait"); expect(r.checks.map(c=>c.state)).toEqual(["stale","invalid_timestamp"]);
});
it("only reviews a change when all required sources were successfully checked",()=>{
  expect(decideResearchReadiness([{id:"a",status:"observed",asOf:now,changed:true}],now).decision).toBe("review");
  expect(decideResearchReadiness([{id:"a",status:"observed",asOf:now,changed:true},{id:"b",status:"unavailable",asOf:null,changed:false}],now).decision).toBe("wait");
  expect(decideResearchReadiness([],now).reason).toBe("incomplete_coverage");
});
