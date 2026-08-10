import { useAppStore } from "../store";
import { useOrientation } from "./use-orientation";

/**
 * Is the VERTICAL tab strip the one currently mounted?
 *
 * Only one bar exists at a time (App renders `!isVertical && <TabBar />` or
 * `isVertical && <VerticalTabBar… />`), and two places now need the answer:
 * App, to pick the bar, and Workspace, to decide whether the Jira ticket rail
 * still owns the ticket list. Keeping the rule in one place stops the two from
 * disagreeing — a Workspace that thinks it is horizontal while the v2 strip is
 * mounted would render BOTH ticket surfaces.
 */
export function useIsVerticalTabBar(): boolean {
  const verticalTabMode = useAppStore((s) => s.verticalTabMode);
  const orientation = useOrientation();
  return (
    verticalTabMode === "always" ||
    (verticalTabMode === "auto" && orientation === "portrait")
  );
}

/**
 * True when the v2 strip is mounted, i.e. when the tab tree — not the
 * `JiraTicketRail` — is the ticket list. The v2 flag alone is not enough: with
 * the horizontal bar showing, the rail is still the only ticket surface there
 * is.
 */
export function useJiraTreeOwnsTickets(): boolean {
  const isVertical = useIsVerticalTabBar();
  const v2 = useAppStore((s) => s.verticalTabBarV2 ?? false);
  return isVertical && v2;
}
