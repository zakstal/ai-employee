import { describe, expect, it } from "vitest";
import { parseTaskList, slug } from "./task-list.js";

const md = `# Tailwind rewrite
- [ ] stray item before any phase
## Phase 1 — primitives
- [ ] Button
- [x] Badge
## Phase 2 — forms
- [ ] Input Field <!-- depends: Button, Badge -->
* [X] Done Thing
not a task line
`;

describe("parseTaskList", () => {
  it("parses phases, checkboxes and depends", () => {
    expect(parseTaskList(md)).toEqual([
      { id: "stray-item-before-any-phase", title: "stray item before any phase", phase: 1, checked: false, depends: [] },
      { id: "button", title: "Button", phase: 1, checked: false, depends: [] },
      { id: "badge", title: "Badge", phase: 1, checked: true, depends: [] },
      { id: "input-field", title: "Input Field", phase: 2, checked: false, depends: ["button", "badge"] },
      { id: "done-thing", title: "Done Thing", phase: 2, checked: true, depends: [] },
    ]);
  });
  it("slug is stable", () => {
    expect(slug("  Date Picker (v2)! ")).toBe("date-picker-v2");
    expect(slug(slug("Date Picker"))).toBe("date-picker");
  });
});
