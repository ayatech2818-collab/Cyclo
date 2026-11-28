import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// logic.ts imports siblings without extensions; resolve them like the bundler does.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const { panelFilterCount, parseBacklogQuery } = await import("../src/features/backlog/logic.ts");
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const board = read("../src/features/backlog/components/backlog-board.tsx");
const EPIC = "00000000-0000-4000-a000-0000000000e1";

test("the filter panel counts only the filters it holds", () => {
  assert.equal(panelFilterCount(parseBacklogQuery({})), 0);
  assert.equal(panelFilterCount(parseBacklogQuery({ q: "login", group: "epic" })), 0, "search and grouping stay outside the panel");
  assert.equal(panelFilterCount(parseBacklogQuery({ type: "BUG", status: "TODO", priority: "high", assignee: "none", epic: EPIC, completed: "1" })), 6);
});

test("reordering keeps the optimistic update, rollback and keyboard paths", () => {
  assert.match(board, /const previous = items;\s*setItems\(next\);/, "optimistic: local order changes first");
  assert.match(board, /if \(response\.error\) \{\s*setItems\(previous\);/, "rollback when the server refuses");
  assert.match(board, /moveBacklogItemAction\(projectId, movedId, placement\.afterId, placement\.beforeId\)/, "same rank placement call");
  assert.match(board, /event\.key === "ArrowUp"\) \{ event\.preventDefault\(\); step\(id, -1\)/);
  assert.match(board, /event\.key === "ArrowDown"\) \{ event\.preventDefault\(\); step\(id, 1\)/);
  assert.match(board, /draggable=\{canPlan\}/, "only planners can drag");
  assert.match(board, /aria-label=\{`Move \$\{item\.issueKey\} up`\}/, "visible move buttons remain");
});

test("bulk editing and add-to-sprint reuse existing actions for planners only", () => {
  assert.match(board, /bulkUpdateAction\(projectId, ids, priority, assignee\)/);
  assert.match(board, /changeMembershipAction\(projectId, sprintId, "add", ids\)/, "the sprint planning page's own action");
  assert.match(board, /\{canPlan && selected\.size > 0 && \(/, "the bulk bar is for planners");
  const page = read("../src/app/(dashboard)/projects/[projectId]/backlog/page.tsx");
  assert.match(page, /const canPlan = writable && isWorkManager\(profile, project\)/, "same permission rule as before");
  assert.match(page, /canPlan \? listSprints\(projectId, "open"/, "sprints are only read for planners");
  assert.doesNotMatch(read("../src/features/backlog/queries.server.ts"), /sprint/i, "no new backlog reads");
});

test("unassigned and unestimated work is visible", () => {
  assert.match(board, /Not estimated/);
  assert.match(board, /Unassigned/);
  const summary = read("../src/features/backlog/components/backlog-summary.tsx");
  assert.match(summary, /label="unassigned"/);
  assert.match(summary, /label="not estimated"/);
});
