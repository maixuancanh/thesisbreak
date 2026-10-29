"use client";
import type React from "react";
import Link from "next/link";
import { createContext, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  UserRound,
  ChevronDown,
  Search,
  Menu,
  MessageCircle,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Button } from "./ui/button";
import { AccountSession, useAccountSession } from "./account-session";
import { SignInLink } from "./sign-in-link";
import { WorkspaceNav } from "./workspace-nav";
import {
  type State,
  KEY,
  empty,
  parsePreviewState,
  serializePreviewState,
  updatePreviewState,
} from "../lib/preview-state";
const Ctx = createContext<{
  state: State;
  update: (f: (s: State) => State) => void;
  ready: boolean;
  notice: string;
}>({ state: empty, update: () => {}, ready: false, notice: "" });
export function PreviewProvider({ children }: { children: React.ReactNode }) {
  return (
    <AccountSession>
      <PreviewShell>{children}</PreviewShell>
    </AccountSession>
  );
}
function PreviewShell({ children }: { children: React.ReactNode }) {
  const { status } = useAccountSession();
  const [state, setState] = useState<State>(empty);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState("");
  const path = usePathname();
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        e.key === "/" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) &&
        !target.isContentEditable
      ) {
        e.preventDefault();
        document
          .querySelector<HTMLInputElement>(".terminal-search input")
          ?.focus();
      }
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        setState(parsePreviewState(raw));
      }
    } catch {
      setNotice(
        "Saved preview data could not be restored. This session starts empty.",
      );
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(KEY, serializePreviewState(state));
    } catch {
      setNotice(
        "Browser storage is unavailable or full. Changes last only for this session.",
      );
    }
  }, [state, ready]);
  const update = (fn: (s: State) => State) =>
    setState((s) => updatePreviewState(s, fn));
  return (
    <Ctx.Provider value={{ state, update, ready, notice }}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <Link href="/" className="brand">
          <span aria-hidden="true">≋</span> THESISBREAK
        </Link>
        <form className="terminal-search" action="/" role="search">
          <Search size={15} />
          <input
            aria-label="Search markets"
            name="q"
            placeholder="Try Lakers, Bitcoin, elections"
            autoComplete="off"
          />
          <kbd>/</kbd>
        </form>
        <div className="account">
          <Link href="/thesis" className="agent-connect">
            <MessageCircle size={15} /> Ask Thesis
          </Link>
          {status?.authenticated ? (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button variant="ghost" aria-label="Account menu">
                  <UserRound size={17} /> Account <ChevronDown size={14} />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="menu"
                  sideOffset={10}
                  align="end"
                >
                  <DropdownMenu.Item asChild>
                    <Link href="/memory">Memory</Link>
                    <Link href="/forecasts">Forecast history</Link>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item asChild>
                    <Link href="/account">Account settings</Link>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ) : (
            <Button asChild variant="default" size="sm">
              <SignInLink>Sign in</SignInLink>
            </Button>
          )}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button
                variant="outline"
                size="icon"
                aria-label="Open navigation"
              >
                <Menu size={17} />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="menu"
                align="end"
                sideOffset={10}
              >
                {[
                  ["/", "Discover"],
                  ["/picks", "My picks"],
                  ["/week", "This week"],
                  ["/memory", "Memory"],
                  ["/account", "Account"],
                ].map(([href, label]) => (
                  <DropdownMenu.Item key={href} asChild>
                    <Link
                      href={href!}
                      aria-current={path === href ? "page" : undefined}
                    >
                      {label}
                    </Link>
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </header>
      {notice && (
        <p className="storage" role="status">
          {notice}
        </p>
      )}
      <WorkspaceNav />
      <div key={path} className="route-surface">
        {children}
      </div>
    </Ctx.Provider>
  );
}
export function usePreview() {
  return useContext(Ctx);
}
