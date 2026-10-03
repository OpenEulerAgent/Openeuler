import { describe, expect, it } from "vitest";
import { NAV_LINKS } from "./Sidebar";

/** Nav wiring for the lanes view (#113): entry between Runs and Settings. */
describe("NAV_LINKS", () => {
  it("lists Lanes between Runs and Settings", () => {
    const labels = NAV_LINKS.map((link) => link.label);
    expect(labels).toEqual(["Dashboard", "Projects", "Runs", "Lanes", "Settings"]);
    expect(NAV_LINKS[3]).toMatchObject({ href: "/lanes", label: "Lanes" });
  });

  it("gives every entry an icon component", () => {
    for (const link of NAV_LINKS) {
      expect(typeof link.Icon).toBe("function");
    }
  });
});
