"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { signIn, signOut } from "next-auth/react";
import { Button } from "./ui/button";
import { KEY } from "../lib/preview-state";
import { ProviderProof } from "./provider-proof";
export function Account() {
  const [status, setStatus] = useState<{
    configured: boolean;
    authenticated: boolean;
    error?: string;
  } | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  async function logout() {
    setLogoutError(null);
    try {
      const result = await signOut({
        redirect: false,
        callbackUrl: "/account",
      });
      if ((result as { error?: string }).error)
        throw new Error("LOGOUT_FAILED");
      window.location.assign("/account");
    } catch {
      setLogoutError(
        "Sign-out could not revoke your session. Please retry when the service is available.",
      );
    }
  }
  useEffect(() => {
    let active = true;
    fetch("/api/auth/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active)
          setStatus({
            configured: false,
            authenticated: false,
            error: "AUTH_UNAVAILABLE",
          });
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <main id="main" className="page narrow">
      <h1>Account & data</h1>
      <section className="panel">
        <h2>
          {status?.authenticated
            ? "You’re signed in"
            : "You’re using a local preview"}
        </h2>
        <p role="status">
          {!status
            ? "Checking sign-in availability…"
            : status.error
              ? "Account service is temporarily unavailable. Your sign-in status could not be checked."
              : status.authenticated
                ? "Your account session is active."
                : status.configured
                  ? "Sign in with Google to create an account."
                  : "Sign-in is unavailable: authentication has not been configured or is temporarily unavailable. You are not signed in."}
        </p>
        {status?.authenticated ? (
          <Button onClick={() => void logout()}>Sign out</Button>
        ) : (
          <Button
            disabled={!status?.configured || Boolean(status?.error)}
            onClick={() => void signIn("google", { callbackUrl: "/account" })}
          >
            {status?.configured ? "Sign in with Google" : "Sign-in unavailable"}
          </Button>
        )}
        {logoutError && <p role="alert">{logoutError}</p>}
        <p>
          Signed-in picks, approved preferences and research conversations are
          saved to your account. Failed drafts stay in this browser tab.
          Fictional preview data under <code>{KEY}</code> is separate and is not
          imported into your account.
        </p>
        <p>
          Approved preferences are queued for Walrus storage. Memory shows
          whether each write has been verified. Pausing or retiring a preference
          stops future use; it does not erase an existing Walrus blob.
        </p>
      </section>
      <details className="panel">
        <summary>Verify memory account on Sui</summary>
        <ProviderProof />
      </details>
      <Button asChild variant="outline">
        <Link href="/memory">Manage preferences</Link>
      </Button>
    </main>
  );
}
