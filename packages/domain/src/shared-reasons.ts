export type SharedReasonGroup = {
  familyId: string;
  originStatus: "verified" | "unknown";
  sourceUrl: string | null;
  pickIds: string[];
  pickCount: number;
  reasonIds: string[];
};
export const SOURCE_LINEAGE_METHODOLOGY = "verified-report-edges-v1";
