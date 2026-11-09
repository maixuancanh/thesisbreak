import { z } from "zod";
import { ruleCheckSchema } from "./settlement-rules";
import { portfolioGroupSchema } from "./portfolio-reasons";

export const pickIntelligenceSchema = z.object({
  rules: ruleCheckSchema,
  connections: z.array(portfolioGroupSchema).max(3),
  connectionsState: z.enum(["checked", "unavailable"]),
  scannedPicks: z.number().int().nonnegative().max(100),
  contextOnly: z.literal(true),
});
export type PickIntelligence = z.infer<typeof pickIntelligenceSchema>;
