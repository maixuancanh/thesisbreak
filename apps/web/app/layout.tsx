import type { Metadata } from "next";
import "./globals.css";
import { PreviewProvider } from "../components/preview";
export const metadata: Metadata = {
  title: "THESISBREAK · Your thinking, in context",
  description: "Local demo preview for thoughtful market picks.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PreviewProvider>{children}</PreviewProvider>
      </body>
    </html>
  );
}
