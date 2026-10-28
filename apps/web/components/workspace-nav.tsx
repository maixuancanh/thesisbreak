"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
export function WorkspaceNav() {
  const path = usePathname();
  if (
    path === "/" ||
    path === "/thesis" ||
    path.startsWith("/live-market/") ||
    path.startsWith("/market/")
  )
    return null;
  return (
    <nav className="workspace-nav" aria-label="Your workspace">
      <Link className="workspace-back" href="/">
        <ArrowLeft size={14} />
        Markets
      </Link>
      {[
        ["/picks", "My picks"],
        ["/week", "This week"],
        ["/memory", "Memory"],
        ["/account", "Account"],
      ].map(([href, label]) => (
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
