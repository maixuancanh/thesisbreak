import { expect, it } from "vitest";
import { replyBlocks } from "../../apps/web/lib/reply-presentation";
it("preserves paragraphs and separates numbered steps and bullets without interpreting HTML", () => {
  expect(
    replyBlocks(
      "First paragraph.\nStill here.\n\n1. **Before:** Check sources.\n2. **After:** Review results.\n\n- One\n- Two\n\n<script>x</script>",
    ),
  ).toEqual([
    { kind: "paragraph", lines: ["First paragraph.", "Still here."] },
    {
      kind: "ordered",
      lines: ["**Before:** Check sources.", "**After:** Review results."],
    },
    { kind: "unordered", lines: ["One", "Two"] },
    { kind: "paragraph", lines: ["<script>x</script>"] },
  ]);
});
