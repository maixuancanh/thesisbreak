import { researchMemoryOperation } from "../../../../lib/server/research-memory-service";
export const runtime="nodejs";
export const GET=(request:Request)=>researchMemoryOperation(request,"habits");
