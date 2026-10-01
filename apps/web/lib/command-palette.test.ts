import { describe, expect, it, vi } from "vitest";
import {
  clampSelection,
  confirmOutcome,
  filterPaletteItems,
  groupPaletteItems,
  INITIAL_PALETTE_STATE,
  paletteReducer,
  selectedPaletteItem,
  type PaletteContext,
  type PaletteItem,
  type PaletteState,
} from "./command-palette";

function navItem(id: string, label: string, path: string): PaletteItem {
  return {
    id,
    group: "Pages",
    label,
    run: (context) => {
      context.router.push(path);
      context.close();
    },
  };
}

const items: PaletteItem[] = [
  navItem("dashboard", "Dashboard", "/"),
  navItem("projects", "Projects", "/projects"),
  navItem("runs", "Runs", "/runs"),
];

function mockContext(overrides: Partial<PaletteContext> = {}): PaletteContext {
  return {
    router: { push: vi.fn() },
    close: vi.fn(),
    projectId: null,
    stopRun: vi.fn(),
    ...overrides,
  };
}

describe("paletteReducer state machine", () => {
  it("starts closed", () => {
    expect(INITIAL_PALETTE_STATE).toEqual({
      open: false,
      query: "",
      selectedIndex: 0,
      confirmId: null,
    });
  });

  it("open → open with reset query/selection/confirm", () => {
    const state = paletteReducer(
      { open: false, query: "old", selectedIndex: 3, confirmId: "stop-run-1" },
      { type: "open" },
    );
    expect(state).toEqual({ open: true, query: "", selectedIndex: 0, confirmId: null });
  });

  it("close keeps query but closes (and cancels confirm)", () => {
    const state = paletteReducer(
      { open: true, query: "x", selectedIndex: 1, confirmId: "stop-run-1" },
      { type: "close" },
    );
    expect(state).toEqual({ open: false, query: "x", selectedIndex: 1, confirmId: null });
  });

  it("toggle flips and resets", () => {
    const opened = paletteReducer(INITIAL_PALETTE_STATE, { type: "toggle" });
    expect(opened.open).toBe(true);
    const closed = paletteReducer({ ...opened, query: "q" }, { type: "toggle" });
    expect(closed).toEqual({ open: false, query: "", selectedIndex: 0, confirmId: null });
  });

  it("typing a query resets selection to the top", () => {
    const state = paletteReducer(
      { open: true, query: "", selectedIndex: 2, confirmId: null },
      { type: "query", value: "ru" },
    );
    expect(state).toEqual({ open: true, query: "ru", selectedIndex: 0, confirmId: null });
  });

  it("move navigates with wrap-around in both directions", () => {
    let state: PaletteState = { open: true, query: "", selectedIndex: 0, confirmId: null };
    state = paletteReducer(state, { type: "move", delta: 1, count: 3 });
    expect(state.selectedIndex).toBe(1);
    state = paletteReducer(state, { type: "move", delta: 1, count: 3 });
    expect(state.selectedIndex).toBe(2);
    // ArrowDown at the bottom wraps to the top.
    state = paletteReducer(state, { type: "move", delta: 1, count: 3 });
    expect(state.selectedIndex).toBe(0);
    // ArrowUp at the top wraps to the bottom.
    state = paletteReducer(state, { type: "move", delta: -1, count: 3 });
    expect(state.selectedIndex).toBe(2);
  });

  it("move is a no-op while closed or with no items", () => {
    const closed = paletteReducer(
      { open: false, query: "", selectedIndex: 0, confirmId: null },
      { type: "move", delta: 1, count: 3 },
    );
    expect(closed.open).toBe(false);
    const empty = paletteReducer(
      { open: true, query: "", selectedIndex: 0, confirmId: null },
      { type: "move", delta: 1, count: 0 },
    );
    expect(empty.selectedIndex).toBe(0);
  });
});

describe("two-step stop confirm (state machine)", () => {
  const open: Parameters<typeof paletteReducer>[0] = {
    open: true,
    query: "",
    selectedIndex: 0,
    confirmId: null,
  };

  it("arm marks the destructive item and a second arm-free activation fires", () => {
    const armed = paletteReducer(open, { type: "arm", id: "stop-run-1" });
    expect(armed.confirmId).toBe("stop-run-1");
    const stopItem: PaletteItem = {
      id: "stop-run-1",
      group: "Runs",
      label: "Stop feature/auth",
      requiresConfirm: true,
      run: (context) => {
        context.stopRun("run-1");
        context.close();
      },
    };
    expect(confirmOutcome(stopItem, open.confirmId)).toBe("arm");
    expect(confirmOutcome(stopItem, armed.confirmId)).toBe("run");
  });

  it("arming one stop item does not confirm a different one", () => {
    const armed = paletteReducer(open, { type: "arm", id: "stop-run-1" });
    const other: PaletteItem = {
      id: "stop-run-2",
      group: "Runs",
      label: "Stop other",
      requiresConfirm: true,
      run: () => undefined,
    };
    expect(confirmOutcome(other, armed.confirmId)).toBe("arm");
  });

  it("non-destructive items fire without arming", () => {
    expect(confirmOutcome(items[0]!, null)).toBe("run");
  });

  it("any other key resets the confirm (query, move, close, toggle)", () => {
    const armed = { ...open, confirmId: "stop-run-1" };
    expect(paletteReducer(armed, { type: "query", value: "s" }).confirmId).toBeNull();
    expect(paletteReducer(armed, { type: "move", delta: 1, count: 3 }).confirmId).toBeNull();
    expect(paletteReducer(armed, { type: "close" }).confirmId).toBeNull();
    expect(paletteReducer(armed, { type: "toggle" }).confirmId).toBeNull();
  });

  it("arm is ignored while closed", () => {
    const closed = paletteReducer({ ...open, open: false }, { type: "arm", id: "stop-run-1" });
    expect(closed.confirmId).toBeNull();
  });
});

describe("filterPaletteItems", () => {
  it("empty query returns all items ordered by canonical group", () => {
    const mixed: PaletteItem[] = [
      { ...navItem("runs", "Runs", "/runs"), group: "Runs" },
      navItem("dashboard", "Dashboard", "/"),
      navItem("projects", "Projects", "/projects"),
    ];
    expect(filterPaletteItems(mixed, "").map((item) => item.id)).toEqual([
      "dashboard",
      "projects",
      "runs",
    ]);
  });

  it("filters by fuzzy label match", () => {
    expect(filterPaletteItems(items, "proj").map((item) => item.id)).toEqual(["projects"]);
    expect(filterPaletteItems(items, "dsh").map((item) => item.id)).toEqual(["dashboard"]);
  });

  it("matches hints and keywords too", () => {
    const item: PaletteItem = {
      ...navItem("runs", "Runs", "/runs"),
      hint: "executions",
      keywords: "history jobs",
    };
    expect(filterPaletteItems([item], "exec")).toHaveLength(1);
    expect(filterPaletteItems([item], "jobs")).toHaveLength(1);
    expect(filterPaletteItems([item], "zzz")).toHaveLength(0);
  });

  it("ranks better matches first", () => {
    const pool: PaletteItem[] = [
      navItem("stop-x", "Stop feature/runs", "/x"),
      navItem("runs", "Runs", "/runs"),
    ];
    expect(filterPaletteItems(pool, "runs")[0]!.id).toBe("runs");
  });
});

describe("selection + dispatch", () => {
  it("clampSelection stays in range and reports nothing at -1", () => {
    expect(clampSelection(5, 3)).toBe(2);
    expect(clampSelection(0, 0)).toBe(-1);
    expect(clampSelection(-1, 3)).toBe(0);
  });

  it("selectedPaletteItem resolves the highlighted item (enter action)", () => {
    let state: PaletteState = { open: true, query: "", selectedIndex: 0, confirmId: null };
    expect(selectedPaletteItem(state, items)!.id).toBe("dashboard");
    state = paletteReducer(state, { type: "move", delta: 2, count: items.length });
    expect(selectedPaletteItem(state, items)!.id).toBe("runs");
    state = paletteReducer(state, { type: "query", value: "proj" });
    expect(selectedPaletteItem(state, items)!.id).toBe("projects");
  });

  it("returns null when nothing matches", () => {
    const state = paletteReducer(
      { open: true, query: "zzz", selectedIndex: 0, confirmId: null },
      { type: "query", value: "zzz" },
    );
    expect(selectedPaletteItem(state, items)).toBeNull();
  });

  it("running a navigate item pushes the route and closes (mocked router)", () => {
    const context = mockContext();
    selectedPaletteItem({ open: true, query: "ru", selectedIndex: 0, confirmId: null }, items)!.run(
      context,
    );
    expect(context.router.push).toHaveBeenCalledWith("/runs");
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("running a stop item fires stopRun only after the second activation", () => {
    const stopItem: PaletteItem = {
      id: "stop-run-1",
      group: "Runs",
      label: "Stop feature/auth",
      requiresConfirm: true,
      run: (context) => {
        context.stopRun("run-1");
        context.close();
      },
    };
    const context = mockContext();
    expect(confirmOutcome(stopItem, null)).toBe("arm");
    expect(context.stopRun).not.toHaveBeenCalled();
    expect(confirmOutcome(stopItem, "stop-run-1")).toBe("run");
    stopItem.run(context);
    expect(context.stopRun).toHaveBeenCalledWith("run-1");
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("new-workflow action targets the current project", () => {
    const item: PaletteItem = {
      id: "action-new-workflow",
      group: "Actions",
      label: "New workflow for this project",
      run: (context) => {
        context.router.push(`/projects/${context.projectId}/workflows/new`);
        context.close();
      },
    };
    const context = mockContext({ projectId: "p1" });
    item.run(context);
    expect(context.router.push).toHaveBeenCalledWith("/projects/p1/workflows/new");
  });
});

describe("groupPaletteItems", () => {
  it("groups in canonical group order and skips empty groups", () => {
    const mixed: PaletteItem[] = [
      { ...navItem("runs", "Runs", "/runs"), group: "Runs" },
      navItem("dashboard", "Dashboard", "/"),
      { ...navItem("stop", "Stop", "/x"), group: "Runs" },
    ];
    const sections = groupPaletteItems(mixed);
    expect(sections.map((section) => section.group)).toEqual(["Pages", "Runs"]);
    expect(sections[1]!.items).toHaveLength(2);
  });
});
