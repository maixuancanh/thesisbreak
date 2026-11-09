import { createRequire } from "node:module";
import type { ReactNode } from "react";
const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { createElement } = require("react") as typeof import("react");
const { renderToStaticMarkup } = require("react-dom/server") as {
  renderToStaticMarkup: (element: ReactNode) => string;
};
import { expect, it } from "vitest";
import { DecisionEvidenceContext } from "../../apps/web/components/decision-evidence-context";
import { CheckProgress } from "../../apps/web/components/check-progress";
import { assessDecisionEvidence } from "../../packages/agent/src/decision-evidence-assessment";
it("server render preserves unknown price without a fabricated number", () => {
  const assessment = assessDecisionEvidence({
    reasonImpact: "invalidated",
    beforeQuote: null,
    afterQuote: null,
  });
  const html = renderToStaticMarkup(
    createElement(DecisionEvidenceContext, { assessment }),
  );
  expect(html).toContain("Your reason needs another look.");
  expect(html).toContain("Price context is unavailable.");
  expect(html).not.toContain("0%");
  expect(html).not.toContain("<svg");
});
it("server render labels unavailable and unsupported checks without a success claim", () => {
  const html = renderToStaticMarkup(
    createElement(CheckProgress, {
      receipts: [
        {
          checkId: "official_lineup",
          procedureVersionId: "v1",
          tool: "read_independent_sources",
          status: "unavailable",
          evidenceIds: [],
          checkedAt: "2026-11-03T12:00:00Z",
        },
        {
          checkId: "resolution_rules",
          procedureVersionId: "v1",
          tool: "read_market",
          status: "unsupported",
          evidenceIds: [],
          checkedAt: "2026-11-03T12:00:00Z",
        },
      ],
    }),
  );
  expect(html).toContain("Could not complete this check.");
  expect(html).toContain("This source is not supported yet.");
  expect(html).not.toContain("Checked with");
});
