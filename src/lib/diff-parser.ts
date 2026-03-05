import type { FileDiff, DiffHunk } from "../types";

/**
 * Parse a unified diff string into structured FileDiff objects.
 */
export function parseUnifiedDiff(rawDiff: string): FileDiff[] {
  if (!rawDiff.trim()) return [];

  const files: FileDiff[] = [];
  // Split by "diff --git" boundaries
  const fileSections = rawDiff.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const fullSection = "diff --git " + section;
    const lines = fullSection.split("\n");

    // Parse file path from "diff --git a/path b/path"
    const headerMatch = lines[0].match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (!headerMatch) continue;

    const filePath = headerMatch[2];

    // Detect status from diff headers
    let status = "M";
    for (const line of lines.slice(1, 10)) {
      if (line.startsWith("new file")) { status = "A"; break; }
      if (line.startsWith("deleted file")) { status = "D"; break; }
      if (line.startsWith("rename from")) { status = "R"; break; }
    }

    // Check for binary files
    if (lines.some(l => l.startsWith("Binary files"))) {
      files.push({ filePath, status, hunks: [], rawDiff: fullSection });
      continue;
    }

    // Parse hunks
    const hunks: DiffHunk[] = [];
    let currentHunk: DiffHunk | null = null;
    let diffHeaderEnd = 0;

    // Find where the actual diff content starts (after ---, +++ lines)
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].startsWith("@@")) {
        diffHeaderEnd = i;
        break;
      }
    }

    // The diff header is everything before the first hunk
    const diffHeader = lines.slice(0, diffHeaderEnd).join("\n");

    for (let i = diffHeaderEnd; i < lines.length; i++) {
      const line = lines[i];
      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);

      if (hunkMatch) {
        // Save previous hunk
        if (currentHunk) {
          currentHunk.rawPatch = buildRawPatch(diffHeader, currentHunk);
          hunks.push(currentHunk);
        }

        currentHunk = {
          header: line,
          oldStart: parseInt(hunkMatch[1], 10),
          oldCount: hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1,
          newStart: parseInt(hunkMatch[3], 10),
          newCount: hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1,
          lines: [],
          rawPatch: "",
        };
        continue;
      }

      if (!currentHunk) continue;

      // Skip "\ No newline at end of file" markers
      if (line.startsWith("\\ No newline")) continue;

      if (line.startsWith("+")) {
        currentHunk.lines.push({
          type: "add",
          content: line.substring(1),
          newLineNumber: currentHunk.newStart + currentHunk.lines.filter(l => l.type !== "remove").length,
        });
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({
          type: "remove",
          content: line.substring(1),
          oldLineNumber: currentHunk.oldStart + currentHunk.lines.filter(l => l.type !== "add").length,
        });
      } else if (line.startsWith(" ") || line === "") {
        // Context line (or empty context line at end of hunk)
        const content = line.startsWith(" ") ? line.substring(1) : line;
        currentHunk.lines.push({
          type: "context",
          content,
          oldLineNumber: currentHunk.oldStart + currentHunk.lines.filter(l => l.type !== "add").length,
          newLineNumber: currentHunk.newStart + currentHunk.lines.filter(l => l.type !== "remove").length,
        });
      }
    }

    // Push last hunk
    if (currentHunk) {
      currentHunk.rawPatch = buildRawPatch(diffHeader, currentHunk);
      hunks.push(currentHunk);
    }

    files.push({ filePath, status, hunks, rawDiff: fullSection });
  }

  return files;
}

/**
 * Build a valid git patch for a single hunk (used for git apply --reverse).
 */
function buildRawPatch(diffHeader: string, hunk: DiffHunk): string {
  const lines: string[] = [diffHeader, hunk.header];
  for (const line of hunk.lines) {
    switch (line.type) {
      case "add":
        lines.push("+" + line.content);
        break;
      case "remove":
        lines.push("-" + line.content);
        break;
      case "context":
        lines.push(" " + line.content);
        break;
    }
  }
  // Ensure patch ends with newline
  return lines.join("\n") + "\n";
}

/**
 * Build a patch string for a specific hunk of a file diff.
 */
export function buildHunkPatch(fileDiff: FileDiff, hunkIndex: number): string {
  if (hunkIndex < 0 || hunkIndex >= fileDiff.hunks.length) {
    return "";
  }
  return fileDiff.hunks[hunkIndex].rawPatch;
}
