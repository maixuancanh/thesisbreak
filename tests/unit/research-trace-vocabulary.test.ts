import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { PUBLIC_RESEARCH_TOOLS } from "../../packages/domain/src/research-tools";
it("durable status vocabulary covers every literal tool emitted by the runtime producer", () => {
  const source = ts.createSourceFile(
    "runtime.ts",
    readFileSync("packages/agent/src/runtime.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const emitted = new Set<string>();
  function walk(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["traceRead", "preloadedToolTrace"].includes(node.expression.text) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      emitted.add(node.arguments[0].text);
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === "tool" &&
      ts.isStringLiteral(node.initializer)
    )
      emitted.add(node.initializer.text);
    ts.forEachChild(node, walk);
  }
  walk(source);
  expect(emitted.size).toBeGreaterThan(8);
  expect(
    [...emitted].filter(
      (tool) => !(PUBLIC_RESEARCH_TOOLS as readonly string[]).includes(tool),
    ),
  ).toEqual([]);
});
