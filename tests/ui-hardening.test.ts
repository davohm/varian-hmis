import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), "utf8");

const NEW_FILES = [
  "src/app/error.tsx",
  "src/app/global-error.tsx",
  "src/app/loading.tsx",
  "src/app/not-found.tsx",
  "src/app/(app)/loading.tsx",
  "src/components/ui/empty-state.tsx",
  "src/components/ui/loading-panel.tsx",
  "src/components/ui/error-panel.tsx",
  "tests/ui-hardening.test.ts",
];

describe("UI hardening source contracts", () => {
  it("ships every route-level and reusable surface", () => {
    for (const file of NEW_FILES) {
      expect(existsSync(join(process.cwd(), file)), file).toBe(true);
    }
  });

  it("uses client error boundaries with retry, digest and offline/sync guidance", () => {
    const boundaries = [
      "src/app/error.tsx",
      "src/app/global-error.tsx",
      "src/components/ui/error-panel.tsx",
    ];

    for (const file of boundaries) {
      const contents = source(file);
      expect(contents.trimStart().startsWith('"use client"'), file).toBe(true);
      expect(contents, file).toContain("reset");
    }

    const panel = source("src/components/ui/error-panel.tsx");
    expect(panel).toContain("reset: () => void");
    expect(panel).toContain("onClick={reset}");
    expect(panel).toContain("Try again");
    expect(panel).toContain("Reload page");
    expect(panel).toContain('role="alert"');
    expect(panel).toContain("digest");
    expect(panel).toContain("Support reference");
    expect(panel).toContain("Not supplied with this error");
    expect(panel).toContain("offline");
    expect(panel).toContain("sync is paused");
    expect(panel).toContain("Do not resubmit");

    for (const file of ["src/app/error.tsx", "src/app/global-error.tsx"]) {
      const contents = source(file);
      expect(contents).toContain("<ErrorPanel");
      expect(contents).toContain("reset={reset}");
    }
  });

  it("renders a self-contained global-error document", () => {
    const contents = source("src/app/global-error.tsx");
    expect(contents).toContain("<html lang=\"en\">");
    expect(contents).toContain("<body");
    expect(contents).toContain('import "./globals.css"');
  });

  it("exposes accessible, motion-safe loading states", () => {
    const panel = source("src/components/ui/loading-panel.tsx");
    expect(panel).toContain('role="status"');
    expect(panel).toContain('aria-live="polite"');
    expect(panel).toContain('aria-busy="true"');
    expect(panel).toContain('className="sr-only"');
    expect(panel).toContain('label = "Loading"');
    expect(panel).toContain("{label}");
    expect(panel).toContain("varian-skeleton");
    expect(panel).toContain("motion-safe:animate-pulse");
    expect(panel).toContain("motion-reduce:animate-none");
    expect(panel).toContain('aria-hidden="true"');

    expect(source("src/app/loading.tsx")).toContain("<LoadingPanel");
    expect(source("src/app/(app)/loading.tsx")).toContain("<LoadingPanel");
    expect(source("src/app/(app)/loading.tsx")).toContain(
      'title="Loading workspace"',
    );
  });

  it("exposes semantic empty states with text-led meaning", () => {
    const empty = source("src/components/ui/empty-state.tsx");
    expect(empty).toContain('role="status"');
    expect(empty).toContain('aria-live="polite"');
    expect(empty).toContain("title: string");
    expect(empty).toContain("description: string");
    expect(empty).toContain("action?: React.ReactNode");
    expect(empty).toContain("headingLevel = 2");
    expect(empty).toContain('const Heading = `h${headingLevel}`');
    expect(empty).toContain("<Heading");
    expect(empty).toContain('aria-hidden="true"');

    const notFound = source("src/app/not-found.tsx");
    expect(notFound).toContain("<EmptyState");
    expect(notFound).toContain("headingLevel={1}");
    expect(notFound).toContain("Page not found");
    expect(notFound).toContain('from "next/link"');
  });

  it("provides a print stylesheet that strips chrome and keeps records intact", () => {
    const css = source("src/app/globals.css");
    expect(css).toContain("UI HARDENING — PRINT STYLESHEET");
    expect(css).toContain("@page");
    expect(css).toContain("@media print");
    expect(css).toContain("display: none !important");
    expect(css).toContain("aside,");
    expect(css).toContain("nav,");
    expect(css).toContain("[data-sonner-toaster]");
    expect(css).toContain("#main-content");
    expect(css).toContain("break-inside: avoid");
    expect(css).toContain('a[href^="https://"]::after');
    expect(css).toContain('content: " (" attr(href) ")"');
    expect(css).toContain("font-size: 10pt");
    expect(css).toContain("thead");
  });

  it("adds focus-visible and reduced-motion helpers without changing brand tokens", () => {
    const css = source("src/app/globals.css");
    expect(css).toContain("UI HARDENING — ACCESSIBILITY HELPERS");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("var(--brand-navy)");
    expect(css).toContain("var(--brand-mint)");
    expect(css.match(/prefers-reduced-motion/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(css).toContain(".varian-skeleton");

    expect(css).toContain("--brand-navy: #022f5b;");
    expect(css).toContain("--brand-mint: #7ac7a1;");
    expect(css).toContain("--brand-offwhite: #fcf9f4;");
  });
});
