"use client";
import { createContext, useContext } from "react";
const Feature = createContext(false);
export function PickReviewFeature({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  return <Feature.Provider value={enabled}>{children}</Feature.Provider>;
}
export function usePickReviewEnabled() {
  return useContext(Feature);
}
