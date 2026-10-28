export function replyBlocks(text: string) {
  const blocks: {
    kind: "paragraph" | "ordered" | "unordered";
    lines: string[];
  }[] = [];
  let previousBlank = true;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) {
      previousBlank = true;
      continue;
    }
    const ordered = line.match(/^\d+[.)]\s+(.+)/),
      unordered = line.match(/^[-*]\s+(.+)/);
    const kind = ordered ? "ordered" : unordered ? "unordered" : "paragraph";
    const value = ordered?.[1] ?? unordered?.[1] ?? line;
    const previous = blocks.at(-1);
    if (!previousBlank && previous?.kind === kind) previous.lines.push(value);
    else blocks.push({ kind, lines: [value] });
    previousBlank = false;
  }
  return blocks;
}
