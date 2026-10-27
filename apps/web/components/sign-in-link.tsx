"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
  const [search, setSearch] = useState("");
  useEffect(() => {
    setSearch(window.location.search);
  }, [path]);
  return (
    <Link className={className} href={signInPath(returnTo ?? path + search)}>
      {children}
    </Link>
  );
}
