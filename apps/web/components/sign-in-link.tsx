"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { signInPath } from "../lib/auth-navigation";

export function SignInLink({
  children = "Sign in",
  className,
  returnTo,
}: {
  children?: ReactNode;
  className?: string;
  returnTo?: string;
}) {
  const path = usePathname();
  const router = useRouter();
  const [search, setSearch] = useState("");
  useEffect(() => {
    setSearch(window.location.search);
  }, [path]);
  return (
    <Link
      className={className}
      href={signInPath(returnTo ?? path + search)}
      onClick={(e) => {
        if (!returnTo && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          router.push(
            signInPath(window.location.pathname + window.location.search),
          );
        }
      }}
    >
      {children}
    </Link>
  );
}
