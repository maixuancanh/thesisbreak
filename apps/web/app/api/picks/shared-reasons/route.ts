import {pickReviewOperation} from '../../../../lib/server/pick-review-service';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export function GET(request:Request){return pickReviewOperation(request,'shared');}
