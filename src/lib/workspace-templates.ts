export interface WorkspaceTemplate {
  id: string;
  name: string;
  description: string;
  cols: number;
  rows: number;
}

export const WORKSPACE_TEMPLATES: WorkspaceTemplate[] = [
  {
    id: "single",
    name: "Single",
    description: "One full-size pane",
    cols: 1,
    rows: 1,
  },
  {
    id: "side-by-side",
    name: "Side by Side",
    description: "Two panes side by side",
    cols: 2,
    rows: 1,
  },
  {
    id: "triple",
    name: "Triple",
    description: "Three panes in a row",
    cols: 3,
    rows: 1,
  },
  {
    id: "quad",
    name: "Quad",
    description: "2x2 grid layout",
    cols: 2,
    rows: 2,
  },
  {
    id: "main-side",
    name: "Main + Side",
    description: "One large pane with two stacked",
    cols: 2,
    rows: 2,
  },
  {
    id: "six-pack",
    name: "Six Pack",
    description: "3x2 grid layout",
    cols: 3,
    rows: 2,
  },
  {
    id: "full-grid",
    name: "Full Grid",
    description: "4x4 grid layout",
    cols: 4,
    rows: 4,
  },
];
