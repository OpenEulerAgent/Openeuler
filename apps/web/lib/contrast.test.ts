import { describe, expect, it } from "vitest";

/**
 * WCAG AA contrast verification for the design tokens (issue #50).
 *
 * The RGB values below are hardcoded copies of apps/web/app/globals.css —
 * keep both in sync. Dark is the default theme; light opts in via
 * `[data-theme="light"]`.
 */

type Rgb = [number, number, number];

const DARK = {
  bg: [0x0b, 0x0f, 0x14] as Rgb,
  surface: [0x11, 0x16, 0x1d] as Rgb,
  elevated: [0x17, 0x1e, 0x26] as Rgb,
  border: [0x26, 0x30, 0x41] as Rgb,
  fg: [0xe6, 0xed, 0xf3] as Rgb,
  mutedFg: [0x94, 0xa3, 0xb8] as Rgb,
  accent: [0x25, 0x63, 0xeb] as Rgb,
  accentFg: [0xff, 0xff, 0xff] as Rgb,
  link: [0x8a, 0xb4, 0xff] as Rgb,
  success: [0x3f, 0xb9, 0x50] as Rgb,
  successSubtle: [0x0f, 0x2b, 0x1c] as Rgb,
  warning: [0xe3, 0xb3, 0x41] as Rgb,
  warningSubtle: [0x2b, 0x24, 0x10] as Rgb,
  danger: [0xf8, 0x51, 0x49] as Rgb,
  dangerStrong: [0xcf, 0x22, 0x2e] as Rgb,
  dangerSubtle: [0x3a, 0x15, 0x18] as Rgb,
  info: [0x58, 0xa6, 0xff] as Rgb,
  infoSubtle: [0x12, 0x25, 0x3f] as Rgb,
};

const LIGHT = {
  bg: [0xf6, 0xf8, 0xfa] as Rgb,
  surface: [0xff, 0xff, 0xff] as Rgb,
  elevated: [0xff, 0xff, 0xff] as Rgb,
  border: [0xd0, 0xd7, 0xde] as Rgb,
  fg: [0x1f, 0x23, 0x28] as Rgb,
  mutedFg: [0x59, 0x63, 0x6e] as Rgb,
  accent: [0x09, 0x69, 0xda] as Rgb,
  accentFg: [0xff, 0xff, 0xff] as Rgb,
  link: [0x09, 0x69, 0xda] as Rgb,
  success: [0x11, 0x63, 0x29] as Rgb,
  successSubtle: [0xda, 0xfb, 0xe1] as Rgb,
  warning: [0x9a, 0x67, 0x00] as Rgb,
  warningSubtle: [0xff, 0xf8, 0xc5] as Rgb,
  danger: [0xa4, 0x0e, 0x26] as Rgb,
  dangerStrong: [0xa4, 0x0e, 0x26] as Rgb,
  dangerSubtle: [0xff, 0xeb, 0xe9] as Rgb,
  info: [0x09, 0x69, 0xda] as Rgb,
  infoSubtle: [0xdd, 0xf4, 0xff] as Rgb,
};

/** WCAG 2.1 relative luminance. */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio between two colors (1..21). */
export function contrastRatio(foreground: Rgb, background: Rgb): number {
  const l1 = luminance(foreground);
  const l2 = luminance(background);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

const AA_TEXT = 4.5;
const AA_LARGE_TEXT = 3.0;

/** Core text pairs every theme must keep readable (badge text is 12px). */
function corePairs(theme: typeof DARK): Array<[string, Rgb, Rgb]> {
  return [
    ["fg on bg", theme.fg, theme.bg],
    ["fg on surface", theme.fg, theme.surface],
    ["fg on elevated", theme.fg, theme.elevated],
    ["muted-fg on bg", theme.mutedFg, theme.bg],
    ["muted-fg on surface", theme.mutedFg, theme.surface],
    ["muted-fg on elevated", theme.mutedFg, theme.elevated],
    ["accent-fg on accent (buttons)", theme.accentFg, theme.accent],
    ["white on danger-strong (danger buttons)", [0xff, 0xff, 0xff], theme.dangerStrong],
    ["link on bg", theme.link, theme.bg],
    ["link on surface", theme.link, theme.surface],
    ["success on success-subtle (badges)", theme.success, theme.successSubtle],
    ["warning on warning-subtle (badges)", theme.warning, theme.warningSubtle],
    ["danger on danger-subtle (badges)", theme.danger, theme.dangerSubtle],
    ["info on info-subtle (badges)", theme.info, theme.infoSubtle],
  ];
}

describe("contrast math", () => {
  it("black on white is 21:1 and identity is 1:1", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([10, 20, 30], [10, 20, 30])).toBeCloseTo(1, 5);
  });
});

describe.each([
  ["dark (default)", DARK],
  ["light", LIGHT],
])("WCAG AA — %s theme", (_name, theme) => {
  it.each(corePairs(theme) as Array<[string, Rgb, Rgb]>)(
    "%s ≥ 4.5:1",
    (label, foreground, background) => {
      const ratio = contrastRatio(foreground, background);
      expect(ratio, `${label} was ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_TEXT);
    },
  );

  it("accent passes at least the large-text threshold everywhere it can appear as text", () => {
    // The accent color itself is mostly a fill/ring; where used as text
    // (larger UI chrome) it must still clear 3:1 on page/surface.
    expect(contrastRatio(theme.accent, theme.bg)).toBeGreaterThanOrEqual(AA_LARGE_TEXT);
    expect(contrastRatio(theme.accent, theme.surface)).toBeGreaterThanOrEqual(AA_LARGE_TEXT);
  });
});
