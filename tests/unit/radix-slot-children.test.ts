import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("Radix asChild wrappers have exactly one JSX element child", () => {
  const failures: string[] = [];
  function inspect(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        inspect(path);
        continue;
      }
      if (!path.endsWith(".tsx")) continue;
      const source = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      function visit(node: ts.Node) {
        if (
          ts.isJsxElement(node) &&
          node.openingElement.attributes.properties.some(
            (p) =>
              ts.isJsxAttribute(p) &&
              p.name.getText(source) === "asChild" &&
              (!p.initializer || p.initializer.getText(source) === "{true}"),
          )
        ) {
          const children = node.children.filter(
            (child) => !ts.isJsxText(child) || !!child.text.trim(),
          );
          if (
            children.length !== 1 ||
            (!ts.isJsxElement(children[0]!) &&
              !ts.isJsxSelfClosingElement(children[0]!))
          )
            failures.push(
              `${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
            );
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  inspect("apps/web/components");
  expect(failures).toEqual([]);
});
