/** Operational codes only: never log SQL, account data, URLs, request bodies or credentials. */
export function reportServiceFailure(
  service: "artifact" | "source_watch" | "learning",
  error: unknown,
) {
  const candidate =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "UNCLASSIFIED";
  const code = /^[A-Z0-9_]{1,64}$/.test(candidate) ? candidate : "UNCLASSIFIED";
  console.error(JSON.stringify({ service, errorCode: code }));
}
