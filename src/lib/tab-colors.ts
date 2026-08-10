import {
  autoAssignColor,
  type ProjectColorId,
} from "../store/recentProjectsSlice";
import type { Tab } from "../types";

/**
 * Give every visible project tab a colour, and make sure no two visible
 * projects wear the same one.
 *
 * Lived inside TabBar's render for a long time, which meant the VERTICAL strip
 * only ever *read* `projectColors`: a project that had never been on screen in
 * horizontal mode had no colour at all, so its rail/trim stayed blank. Both
 * bars call this now.
 *
 * Returns the merged map so the caller can paint in the SAME render pass that
 * assigns — the store commit lands a tick later, and a tab that painted from
 * the store alone would flash uncoloured on its first frame.
 */
export function syncProjectColors(
  visibleTabs: Tab[],
  projectColors: Record<string, ProjectColorId>,
  setProjectColor: (dir: string, colorId: ProjectColorId) => void,
): Record<string, ProjectColorId> {
  // Local map so tabs assigned in the same pass can see each other.
  const localColors = { ...projectColors };
  const pendingAssigns: Array<[string, ProjectColorId]> = [];

  const visibleDirs = new Set<string>();
  for (const tab of visibleTabs) {
    if (tab.isKanbanTab || tab.isDevServerTab || tab.isServersTab || tab.isSettingsTab) continue;
    const dir = (tab.workingDir ?? "").replace(/\\/g, "/");
    if (dir) visibleDirs.add(dir);
  }

  for (const dir of visibleDirs) {
    if (localColors[dir] === undefined) {
      const newId = autoAssignColor(localColors);
      localColors[dir] = newId;
      pendingAssigns.push([dir, newId]);
    }
  }

  // Dedup: two visible projects sharing a colour defeats the point of having
  // one. Keep the first, reassign the rest.
  const colorToDirs = new Map<string, string[]>();
  for (const dir of visibleDirs) {
    const cid = localColors[dir];
    if (!cid) continue;
    const list = colorToDirs.get(cid) ?? [];
    list.push(dir);
    colorToDirs.set(cid, list);
  }
  for (const [, dirs] of colorToDirs) {
    if (dirs.length <= 1) continue;
    for (let i = 1; i < dirs.length; i++) {
      const newId = autoAssignColor(localColors);
      localColors[dirs[i]] = newId;
      pendingAssigns.push([dirs[i], newId]);
    }
  }

  for (const [dir, colorId] of pendingAssigns) {
    setProjectColor(dir, colorId);
  }
  return localColors;
}
