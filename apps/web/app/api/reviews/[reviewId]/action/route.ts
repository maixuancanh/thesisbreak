import {pickReviewOperation} from '../../../../../lib/server/pick-review-service';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:Request,context:{params:Promise<{reviewId:string}>}){return pickReviewOperation(request,'action',(await context.params).reviewId);}
