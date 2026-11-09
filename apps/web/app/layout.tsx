import { PickReviewFeature } from "../components/pick-review-feature";
import type { Metadata } from "next";
import "./globals.css";
import "./market-surface.css";
import { PreviewProvider } from "../components/preview";
export const metadata: Metadata = {
  title: "THESISBREAK · Your thinking, in context",
  description: "Local demo preview for thoughtful market picks.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PickReviewFeature
          enabled={process.env.PICK_REVIEW_UI_ENABLED === "true"}
        >
          <PreviewProvider>{children}</PreviewProvider>
        </PickReviewFeature>
      </body>
    </html>
  );
}
