// @vitest-environment jsdom
//
// SubworkflowLinks (#117): renders nothing for ordinary runs; "child of
// <run>" (link up) for child runs; one link per spawned child run for
// parents.

import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SubworkflowLinks } from "./SubworkflowLinks";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const renderLinks = (props: { parentRunId?: string; childRunIds?: string[] }): void => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(SubworkflowLinks, { runId: "run-x", ...props }));
  });
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("SubworkflowLinks (#117)", () => {
  it("renders nothing for an ordinary run", () => {
    renderLinks({});
    expect(document.querySelector("[data-subworkflow-links]")).toBeNull();
  });

  it("renders the child-of link for a child run", () => {
    renderLinks({ parentRunId: "aaaaaaaa-bbbb" });
    const link = document.querySelector("[data-parent-run-link]") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/runs/aaaaaaaa-bbbb");
    expect(document.querySelector("[data-subworkflow-links]")?.textContent).toContain("child of");
    expect(document.querySelector("[data-child-run-link]")).toBeNull();
  });

  it("renders one link per child run for a parent", () => {
    renderLinks({ childRunIds: ["cccccccc-1", "dddddddd-2"] });
    const links = [...document.querySelectorAll("[data-child-run-link]")];
    expect(links.map((el) => el.getAttribute("href"))).toEqual([
      "/runs/cccccccc-1",
      "/runs/dddddddd-2",
    ]);
    expect(document.querySelector("[data-subworkflow-links]")?.textContent).toContain(
      "2 child runs",
    );
    expect(document.querySelector("[data-parent-run-link]")).toBeNull();
  });
});
