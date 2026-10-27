"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { signIn, signOut } from "next-auth/react";
import { ArrowLeft, Leaf } from "lucide-react";
import { Button } from "./ui/button";
import { ProviderProof } from "./provider-proof";
import { useAccountSession } from "./account-session";
import { safeReturnTo } from "../lib/auth-navigation";

export function Account() {
  const { status, refresh } = useAccountSession();
  const [returnTo, setReturnTo] = useState("/");
  const [oauthError, setOauthError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setReturnTo(
      safeReturnTo(
        params.get("returnTo") ?? params.get("callbackUrl"),
        window.location.origin,
      ),
    );
    setOauthError(params.has("error"));
  }, []);
  async function login() {
    setBusy(true);
    setError("");
    try {
      const result = await signIn("google", { callbackUrl: returnTo });
      if (result?.error) throw new Error("SIGN_IN_FAILED");
    } catch {
      setError("Couldn’t open Google sign-in. Please try again.");
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    setError("");
    try {
      const result = await signOut({ redirect: false, callbackUrl: "/" });
      if ((result as { error?: string }).error)
        throw new Error("LOGOUT_FAILED");
      window.location.assign("/");
    } catch {
      setError("Couldn’t sign you out. Please try again.");
      setBusy(false);
    }
  }
  const signedIn = status?.authenticated;
  return (
    <main id="main" className="page account-page">
      <Link href={returnTo} className="account-back">
        <ArrowLeft size={16} aria-hidden="true" /> Back to{" "}
        {returnTo === "/" ? "Discover" : "what you were doing"}
      </Link>
      <section className="account-card" aria-busy={!status || busy}>
        <span className="account-emblem" aria-hidden="true">
          <Leaf size={26} />
        </span>
        <h1>{signedIn ? "Your account" : "Welcome to Thesisbreak"}</h1>
        <p className="account-intro">
          {signedIn
            ? "Your picks, conversations and preferences, together."
            : "Save your picks. Keep your conversations. Help Thesis learn what matters to you."}
        </p>
        {!status ? (
          <p role="status">Checking your account…</p>
        ) : signedIn ? (
          <>
            <Button asChild size="lg" className="account-primary">
              <Link href={returnTo}>Continue</Link>
            </Button>
            <div className="account-shortcuts">
              <Link href="/picks">My picks</Link>
              <Link href="/memory">Memory</Link>
            </div>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void logout()}
            >
              {busy ? "Signing out…" : "Sign out"}
            </Button>
          </>
        ) : status.error || !status.configured ? (
          <div role="status">
            <p>Sign-in is temporarily unavailable.</p>
            <Button variant="outline" onClick={refresh}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            <Button
              size="lg"
              className="account-primary"
              disabled={busy}
              onClick={() => void login()}
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                width="20"
                height="20"
              >
                <path
                  fill="currentColor"
                  d="M21.6 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.4a4.6 4.6 0 0 1-2 3v2.5h3.3c2-1.8 2.9-4.3 2.9-7.4ZM12 22c2.7 0 5-.9 6.7-2.4l-3.3-2.5c-.9.6-2 .9-3.4.9-2.6 0-4.9-1.8-5.7-4.2H2.9v2.6A10 10 0 0 0 12 22ZM6.3 13.8a6 6 0 0 1 0-3.6V7.6H2.9a10 10 0 0 0 0 8.8l3.4-2.6ZM12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A9.6 9.6 0 0 0 12 2a10 10 0 0 0-9.1 5.6l3.4 2.6C7.1 7.8 9.4 6 12 6Z"
                />
              </svg>
              {busy ? "Opening Google…" : "Continue with Google"}
            </Button>
            <p className="small muted">
              New here? Your account is created automatically.
            </p>
          </>
        )}
        {(error || oauthError) && (
          <p className="account-error" role="alert">
            {error || "Google sign-in wasn’t completed. Please try again."}
          </p>
        )}
      </section>
      <details className="account-details">
        <summary>How your data is saved</summary>
        <p>
          Picks and conversations stay with your account. Preferences are sent
          to Walrus Memory only after you review and approve them. Check Memory
          to see when storage is verified.
        </p>
        <p>
          Pausing or retiring a preference stops future use. It does not erase a
          stored Walrus copy. Sample data stays separate from your account.
        </p>
        {signedIn && (
          <details>
            <summary>Verify storage account</summary>
            <ProviderProof />
          </details>
        )}
      </details>
    </main>
  );
}
