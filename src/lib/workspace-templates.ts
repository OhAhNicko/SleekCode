export interface WorkspaceTemplate {
  id: string;
  name: string;
  description: string;
  cols: number;
  rows: number;
  paneCount: number;
}

export const WORKSPACE_TEMPLATES: WorkspaceTemplate[] = [
  { id: "single", name: "Single",       description: "1 session",    paneCount: 1,  cols: 1, rows: 1 },
  { id: "2",      name: "2 Sessions",   description: "2x1 layout",   paneCount: 2,  cols: 2, rows: 1 },
  { id: "4",      name: "4 Sessions",   description: "2x2 layout",   paneCount: 4,  cols: 2, rows: 2 },
  { id: "6",      name: "6 Sessions",   description: "3x2 layout",   paneCount: 6,  cols: 3, rows: 2 },
  { id: "8",      name: "8 Sessions",   description: "4x2 layout",   paneCount: 8,  cols: 4, rows: 2 },
  { id: "10",     name: "10 Sessions",  description: "4-col layout",  paneCount: 10, cols: 4, rows: 3 },
  { id: "12",     name: "12 Sessions",  description: "4x3 layout",   paneCount: 12, cols: 4, rows: 3 },
  { id: "14",     name: "14 Sessions",  description: "4-col layout",  paneCount: 14, cols: 4, rows: 4 },
  { id: "16",     name: "16 Sessions",  description: "4x4 layout",   paneCount: 16, cols: 4, rows: 4 },
];
