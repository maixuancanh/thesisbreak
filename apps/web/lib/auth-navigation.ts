/** Only return to product pages, never an external origin or an auth endpoint. */
export function safeReturnTo(
  value: string | null | undefined,
  origin?: string,
): string {
  if (origin && value?.startsWith(origin + "/")) {
    try {
      const url = new URL(value);
      if (url.origin !== origin || url.username || url.password) return "/";
      value = url.pathname + url.search + url.hash;
    } catch {
      return "/";
    }
  }
  if (!value || !value.startsWith("/") || /[\\\s]/.test(value)) return "/";
  try {
    const decoded = decodeURIComponent(value);
    if (/[\\\s]/.test(decoded) || decoded.startsWith("//")) return "/";
    const url = new URL(decoded, "https://thesisbreak.invalid");
    if (
      url.origin !== "https://thesisbreak.invalid" ||
      /^\/(api|account)(\/|$)/.test(url.pathname)
    )
      return "/";
    return value;
  } catch {
    return "/";
  }
}
export function signInPath(returnTo: string) {
  return `/account?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
}
