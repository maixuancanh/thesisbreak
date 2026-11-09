import {pickReasonOperation} from '../../../../../lib/server/pick-reason-service';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request,context:{params:Promise<{pickId:string}>}){return pickReasonOperation(request,(await context.params).pickId);}
export async function POST(request:Request,context:{params:Promise<{pickId:string}>}){return pickReasonOperation(request,(await context.params).pickId);}
