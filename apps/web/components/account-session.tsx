"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

type AccountStatus = {
  configured: boolean;
  authenticated: boolean;
  error?: string;
};
const Context = createContext<{
  status: AccountStatus | null;
  refresh: () => void;
}>({ status: null, refresh: () => {} });
export function AccountSession({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setStatus(null);
    void fetch("/api/auth/status", {
      cache: "no-store",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
    })
      .then(async (response) => {
        const data = await response.json();
        if (!controller.signal.aborted)
          setStatus({
            configured: data.configured === true,
            authenticated: response.ok && data.authenticated === true,
            ...(!response.ok || data.error ? { error: "unavailable" } : {}),
          });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setStatus({
            configured: false,
            authenticated: false,
            error: "unavailable",
          });
      });
    return () => controller.abort();
  }, [revision]);
  return (
    <Context.Provider
      value={{ status, refresh: () => setRevision((value) => value + 1) }}
    >
      {children}
    </Context.Provider>
  );
}
export const useAccountSession = () => useContext(Context);
