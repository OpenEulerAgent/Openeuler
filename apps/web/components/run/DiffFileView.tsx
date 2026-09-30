"use client";

import { useMemo } from "react";
import ReactDiffViewer from "react-diff-viewer-continued";
import { languageForPath, type DiffFileEntry } from "@/lib/diff-parse";

/**
 * Split/unified renderer for one parsed file section. This component (and
 * with it react-diff-viewer-continued + refractor) is loaded via
 * next/dynamic with ssr:false from the Diffs tab, so none of it lands in the
 * run page's initial JS. Syntax highlighting uses the viewer's built-in
 * refractor integration (`highlightLanguage`); grammar chunks load on
 * demand per language.
 */
export function DiffFileView({
  entry,
  split,
  useDarkTheme,
}: {
  entry: DiffFileEntry;
  split: boolean;
  useDarkTheme: boolean;
}) {
  const language = useMemo(
    () => languageForPath(entry.newPath || entry.oldPath),
    [entry.newPath, entry.oldPath],
  );

  if (entry.isBinary) {
    return (
      <p className="px-4 py-3 font-mono text-xs text-slate-500">
        Binary file ({entry.isDeleted ? "deleted" : entry.isNew ? "added" : "changed"}) — content
        not shown.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto text-xs">
      <ReactDiffViewer
        oldValue={entry.oldText}
        newValue={entry.newText}
        splitView={split}
        useDarkTheme={useDarkTheme}
        hideLineNumbers={false}
        leftTitle={entry.oldPath || "/dev/null"}
        rightTitle={entry.newPath || "/dev/null"}
        {...(language === undefined ? {} : { highlightLanguage: language })}
        styles={{
          variables: {
            light: { codeFoldGutterBackground: "#f8fafc", codeFoldBackground: "#f8fafc" },
            dark: { codeFoldGutterBackground: "#0f172a", codeFoldBackground: "#0f172a" },
          },
        }}
      />
    </div>
  );
}

export default DiffFileView;
