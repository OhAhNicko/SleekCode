import type { StateCreator } from "zustand";

export interface SnippetVariable {
  name: string;
  defaultValue: string;
  description?: string;
}

export interface Snippet {
  id: string;
  name: string;
  description: string;
  commands: string[];
  variables: SnippetVariable[];
  workingDir?: string;
  createdAt: number;
}

export interface SnippetSlice {
  snippets: Snippet[];
  addSnippet: (snippet: Omit<Snippet, "id" | "createdAt">) => void;
  updateSnippet: (id: string, updates: Partial<Omit<Snippet, "id" | "createdAt">>) => void;
  removeSnippet: (id: string) => void;
}

/** Auto-detect variables from command text ($VAR_NAME pattern). */
export function detectVariables(commands: string[]): SnippetVariable[] {
  const seen = new Set<string>();
  const vars: SnippetVariable[] = [];
  const pattern = /\$([A-Z_][A-Z0-9_]*)/g;
  for (const cmd of commands) {
    let match;
    while ((match = pattern.exec(cmd)) !== null) {
      const name = match[1];
      if (!seen.has(name)) {
        seen.add(name);
        vars.push({ name, defaultValue: "" });
      }
    }
  }
  return vars;
}

/** Interpolate variables into command text. */
export function interpolateVariables(
  command: string,
  values: Record<string, string>
): string {
  return command.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => {
    return values[name] ?? `$${name}`;
  });
}

export const createSnippetSlice: StateCreator<
  SnippetSlice,
  [],
  [],
  SnippetSlice
> = (set) => ({
  snippets: [],

  addSnippet: (snippet) => {
    const newSnippet: Snippet = {
      ...snippet,
      id: `snip-${Date.now()}`,
      createdAt: Date.now(),
    };
    set((state) => ({
      snippets: [...state.snippets, newSnippet],
    }));
  },

  updateSnippet: (id, updates) => {
    set((state) => ({
      snippets: state.snippets.map((s) =>
        s.id === id ? { ...s, ...updates } : s
      ),
    }));
  },

  removeSnippet: (id) => {
    set((state) => ({
      snippets: state.snippets.filter((s) => s.id !== id),
    }));
  },
});
