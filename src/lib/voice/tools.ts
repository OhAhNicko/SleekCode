/**
 * Tool schema for the voice agent's intent → action mapping.
 *
 * The LLM receives this schema (in OpenAI tools format) plus a JSON snapshot
 * of the current app state, and emits one or more tool calls. The dispatcher
 * (./dispatcher.ts) maps each tool call to the matching Zustand store action.
 *
 * Tool names and arg keys are English regardless of the user's spoken language —
 * the LLM is instructed to translate naturally-phrased requests into these
 * canonical forms.
 */

export type JsonSchemaProp = {
  type: "string" | "number" | "integer" | "boolean";
  description?: string;
  enum?: string[];
};

export type ToolDef = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, JsonSchemaProp>;
    required?: string[];
  };
  /** True when the tool needs an immediately-preceding `confirm_destructive` call. */
  destructive?: boolean;
};

export const VOICE_TOOLS: ToolDef[] = [
  {
    name: "add_terminal_pane",
    description: "Add a new terminal pane to the current tab's grid. Use for 'open a new terminal', 'add a Claude pane', etc.",
    parameters: {
      type: "object",
      properties: {
        cli: {
          type: "string",
          enum: ["claude", "codex", "gemini", "shell"],
          description: "Which CLI to launch in the new pane. Defaults to 'shell' if unspecified.",
        },
      },
    },
  },
  {
    name: "add_browser_pane",
    description: "Open a browser preview pane with the given URL. Use for 'open github.com in a browser', 'open browser to news.ycombinator.com'.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to load. http:// is auto-prepended if no scheme is given.",
        },
        side: {
          type: "string",
          enum: ["left", "right"],
          description: "Which side of the layout to place the browser pane. Defaults to user's setting.",
        },
        size_percent: {
          type: "integer",
          description: "Width as a percentage 20–60. Defaults to 35.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "close_pane",
    description: "Close a specific pane in the active tab. Use 'pane_ref' to refer to it (e.g. 'browser', 'leftmost terminal', 'claude pane', or a pane id from the snapshot).",
    parameters: {
      type: "object",
      properties: {
        pane_ref: {
          type: "string",
          description: "Natural-language reference to the pane, OR a pane id from the snapshot.",
        },
      },
      required: ["pane_ref"],
    },
  },
  {
    name: "expand_pane",
    description: "Expand a pane to fill the workspace.",
    parameters: {
      type: "object",
      properties: {
        pane_ref: { type: "string", description: "Reference or id." },
      },
      required: ["pane_ref"],
    },
  },
  {
    name: "popout_pane",
    description: "Pop a pane out into a floating window.",
    parameters: {
      type: "object",
      properties: {
        pane_ref: { type: "string", description: "Reference or id." },
      },
      required: ["pane_ref"],
    },
  },
  {
    name: "minimize_pane",
    description: "Restore an expanded or floating pane back into the grid.",
    parameters: {
      type: "object",
      properties: {
        pane_ref: { type: "string", description: "Reference or id." },
      },
      required: ["pane_ref"],
    },
  },
  {
    name: "switch_tab",
    description: "Switch to a different tab/workspace by name or 1-based index.",
    parameters: {
      type: "object",
      properties: {
        tab_ref: { type: "string", description: "Tab name (substring match) or 1-based index as a string." },
      },
      required: ["tab_ref"],
    },
  },
  {
    name: "close_tab",
    description: "Close a tab. Must be preceded by confirm_destructive when the tab has open panes.",
    parameters: {
      type: "object",
      properties: {
        tab_ref: { type: "string", description: "Tab name or 1-based index. Use 'current' for the active tab." },
      },
      required: ["tab_ref"],
    },
    destructive: true,
  },
  {
    name: "set_theme",
    description: "Change the app theme by id. The snapshot lists available theme ids.",
    parameters: {
      type: "object",
      properties: {
        theme_id: { type: "string", description: "Theme id from the available_themes list in the snapshot." },
      },
      required: ["theme_id"],
    },
  },
  {
    name: "set_setting",
    description: "Change one of the whitelisted user settings. The snapshot lists allowed keys and current values.",
    parameters: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Setting key from the writable_settings list.",
        },
        value: {
          type: "string",
          description: "New value, encoded as a string (e.g. 'true', '14', 'right').",
        },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "open_settings",
    description: "Open the Settings panel.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "open_command_palette",
    description: "Open the command palette (Ctrl+K).",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "toggle_sidebar",
    description: "Show or hide the left sidebar.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "clarify",
    description: "Ask the user a clarifying question — use when the request is ambiguous (e.g. multiple browser panes match 'close the browser'). The HUD will display the question and wait for the user's next utterance.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "Short, natural-language question in the user's language." },
      },
      required: ["question"],
    },
  },
  {
    name: "confirm_destructive",
    description: "Request confirmation before running a destructive action. Must be the call immediately preceding any tool tagged destructive.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One-line summary of what will be done, in the user's language." },
      },
      required: ["summary"],
    },
  },
  {
    name: "say",
    description: "Spoken/visible feedback to the user. Use this for the final reply when no further actions are needed, or to comment on a result.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Text to speak/show. Use the user's language." },
      },
      required: ["message"],
    },
  },
];

/** Whitelist of writable settings exposed via set_setting. Keep tight. */
export const WRITABLE_SETTINGS: Record<string, "boolean" | "number" | "string"> = {
  // Behavior
  alwaysShowTemplatePicker: "boolean",
  restoreLastSession: "boolean",
  autoInsertClipboardImage: "boolean",
  copyOnSelect: "boolean",
  confirmQuit: "boolean",
  showTabPath: "boolean",
  // Layout
  wideGridLayout: "boolean",
  redistributeOnClose: "boolean",
  openPanesInBackground: "boolean",
  // Browser
  browserFullColumn: "boolean",
  browserSpawnLeft: "boolean",
  // Composer
  promptComposerEnabled: "boolean",
  promptComposerAlwaysVisible: "boolean",
  // Theme accent
  vibrantColors: "boolean",
};

/** Tools formatted for OpenAI-compatible /v1/chat/completions `tools` field. */
export function toolsForOpenAi() {
  return VOICE_TOOLS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function isDestructive(name: string): boolean {
  return !!VOICE_TOOLS.find((t) => t.name === name)?.destructive;
}
