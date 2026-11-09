"use client";
import { useState } from "react";
import { signOut } from "next-auth/react";
import { LogOut } from "lucide-react";
import { Button } from "./ui/button";
import { DropdownMenu } from "radix-ui";

export function AccountSignOut() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function logout() {
    setBusy(true);
    setError("");
    try {
      const result = await signOut({ redirect: false, callbackUrl: "/" });
      if (!result || (result as { error?: string }).error)
        throw new Error("LOGOUT_FAILED");
      window.location.assign("/");
    } catch {
      setError("Couldn’t sign you out. Please try again.");
      setBusy(false);
    }
  }
  return (
    <div className="account-sign-out">
      <DropdownMenu.Item asChild onSelect={(event) => event.preventDefault()}>
        <Button variant="ghost" disabled={busy} onClick={() => void logout()}>
          <LogOut size={16} aria-hidden="true" />
          {busy ? "Signing out…" : "Sign out"}
        </Button>
      </DropdownMenu.Item>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
