/** Display-only aliases. Stored model output and evidence authority stay unchanged. */
export function presentReplyCitations(
  text: string,
  sources: readonly { id: string }[],
) {
  const labels = new Map(
    sources.map((source, index) => [source.id, String(index + 1)]),
  );
  return text.replace(/\[([^\]\n]+)\]/g, (original, content: string) => {
    const ids = content.split(",").map((id) => id.trim());
    if (!ids.every((id) => labels.has(id) || id === "independent-status"))
      return original;
    return `[${ids.map((id) => labels.get(id) ?? "Source status").join(", ")}]`;
  });
}
