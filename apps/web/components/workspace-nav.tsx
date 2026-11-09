"use client";
import { usePickReviewEnabled } from "./pick-review-feature";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
export function WorkspaceNav() {
  const path = usePathname();
  const enabled = usePickReviewEnabled();
  const inMarkets =
    path === "/" ||
    path.startsWith("/live-market/") ||
    path.startsWith("/market/");
  if (path === "/thesis") return null;
  return (
    <nav className="workspace-nav" aria-label="Your workspace">
      <Link
        className="workspace-back"
        href="/"
        aria-current={
          path === "/" ? "page" : inMarkets ? "location" : undefined
        }
      >
        {path !== "/" && <ArrowLeft size={14} aria-hidden="true" />}
        Markets
      </Link>
      {[
        ["/today", "Today"],
        ["/picks", "My picks"],
        ["/week", "This week"],
        ["/memory", "Memory"],
        ["/account", "Account"],
      ]
        .filter(([href]) => enabled || href !== "/today")
        .map(([href, label]) => (
          <Link
            key={href}
            href={href!}
            aria-current={path === href ? "page" : undefined}
          >
            {label}
          </Link>
        ))}
    </nav>
  );
}
