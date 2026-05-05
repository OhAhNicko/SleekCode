import { VOICE_TOOLS } from "./tools";
import type { AppContextSnapshot } from "./contextSnapshot";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface InterpretResult {
  toolCalls: ToolCall[];
  /** Free-text content the model returned alongside (or instead of) tool calls. */
  content: string;
  latencyMs: number;
}

export interface InterpretOpts {
  url: string;
  model: string;
  signal?: AbortSignal;
}

function buildSystemPrompt(): string {
  // Render the tool catalog inline so the model sees it as part of its instructions.
  const toolDocs = VOICE_TOOLS.map((t) => {
    const params = Object.entries(t.parameters.properties).map(([k, p]) => {
      const enumStr = p.enum ? ` (one of: ${p.enum.join(", ")})` : "";
      const req = (t.parameters.required ?? []).includes(k) ? " [required]" : "";
      return `    - ${k}: ${p.type}${enumStr}${req} — ${p.description ?? ""}`;
    }).join("\n");
    return `  • ${t.name} — ${t.description}\n${params || "    (no arguments)"}`;
  }).join("\n");

  return `You are EzyDev's voice agent. The user speaks to you in English or Swedish; reply in the same language they used.

Your only job: turn each utterance into JSON tool calls that operate the app.

AVAILABLE TOOLS:
${toolDocs}

OUTPUT FORMAT — STRICT JSON OBJECT:
- Reply with EXACTLY this shape: {"calls": [<tool_call>, <tool_call>, ...]}
- Each entry in "calls": {"name": "<tool_name>", "arguments": {<args>}}
- No prose, no markdown fences, no commentary. The first character is '{', the last is '}'.

EXAMPLES (study these carefully — match the format exactly):

User: "open hacker news in a browser"
Reply: {"calls":[{"name":"add_browser_pane","arguments":{"url":"https://news.ycombinator.com"}},{"name":"say","arguments":{"message":"Opened Hacker News."}}]}

User: "spawn a Claude code pane"
Reply: {"calls":[{"name":"add_terminal_pane","arguments":{"cli":"claude"}},{"name":"say","arguments":{"message":"Opened a Claude pane."}}]}

User: "spawn a cloud code pane"   (Whisper misheard "Claude" — still means Claude)
Reply: {"calls":[{"name":"add_terminal_pane","arguments":{"cli":"claude"}},{"name":"say","arguments":{"message":"Opened a Claude pane."}}]}

User: "open a Gemini pane"
Reply: {"calls":[{"name":"add_terminal_pane","arguments":{"cli":"gemini"}},{"name":"say","arguments":{"message":"Opened a Gemini pane."}}]}

User: "öppna en ny Claude-terminal"
Reply: {"calls":[{"name":"add_terminal_pane","arguments":{"cli":"claude"}},{"name":"say","arguments":{"message":"Öppnade en ny Claude-terminal."}}]}

User: "stäng den vänstra terminalen"
Reply: {"calls":[{"name":"close_pane","arguments":{"pane_ref":"leftmost terminal"}},{"name":"say","arguments":{"message":"Stängde den vänstra terminalen."}}]}

User: "switch to the tasks tab"
Reply: {"calls":[{"name":"switch_tab","arguments":{"tab_ref":"tasks"}},{"name":"say","arguments":{"message":"Switched to Tasks."}}]}

User: "byt till mörkt tema"
Reply: {"calls":[{"name":"set_theme","arguments":{"theme_id":"dracula"}},{"name":"say","arguments":{"message":"Bytte till Dracula-tema."}}]}

Rules:
- ALWAYS emit at least one action tool call when the user asks for something + a final 'say' confirming it.
- For ambiguous references (e.g. multiple browser panes), use 'clarify' with a short question in the user's language.
- For destructive actions (closing tabs with content), use 'confirm_destructive' FIRST, then the destructive call.
- 'pane_ref' accepts either a pane id from the snapshot or a natural-language reference like "the leftmost terminal", "browser", "claude pane".
- 'set_setting' only accepts keys listed in writable_settings.
- Never invent tool names or arguments not listed above.

SPEECH-RECOGNITION DISAMBIGUATION (the user's audio was transcribed by Whisper, which mishears these often):
- "cloud", "clod", "Claud", "claud", "klot", "klod", "kloud" → Claude (CLI). When the user says any of these in the context of code/terminal/pane/CLI, treat it as 'claude'.
- "kodex", "codecs", "codeax" → Codex.
- "Jeminai", "jemini", "jiminy" → Gemini.
- "izy dev", "easy dev", "easydev" → EzyDev (the app itself).
- "pain", "pen" near "open"/"close"/"new" → pane.
- "tab", "tabb", "flik" → tab.
- Swedish: "öppna" = open, "stäng" = close, "byt" = switch, "ny" = new, "till" = to, "flik" = tab, "fönster" = window/pane.
Apply these substitutions silently — never ask the user to repeat themselves over a misheard word.`;
}

/**
 * Send {transcript, snapshot} to an OpenAI-compatible /v1/chat/completions
 * endpoint with the voice tool schema. Returns parsed tool_calls + any content.
 *
 * Compatible with: Ollama (≥0.4), llama.cpp server, vLLM, mlx-lm with --enable-tools.
 */
export async function interpret(
  transcript: string,
  snapshot: AppContextSnapshot,
  opts: InterpretOpts
): Promise<InterpretResult> {
  if (!opts.url) throw new Error("LLM endpoint not configured.");
  if (!opts.model) throw new Error("LLM model not configured.");

  // We DO NOT send the OpenAI `tools` field — many local models (mistral-nemo,
  // older qwen, llama3) get confused when their template doesn't include a
  // tool-calling slot and Ollama returns empty content. Instead we describe the
  // tool schema in the system prompt and parse a JSON array out of `content`.
  const body = {
    model: opts.model,
    stream: false,
    temperature: 0,
    // Ollama-specific: keep the model resident for 1h after each call so the
    // next voice command doesn't pay the cold-load tax (~20s for a 14B model).
    // Ignored by non-Ollama servers.
    keep_alive: "1h",
    // Ollama JSON mode — forces the model to emit syntactically valid JSON.
    // We wrap the array in {"calls": [...]} because Ollama's `format: "json"`
    // requires an object (not a bare array). The content parser unwraps it.
    response_format: { type: "json_object" },
    format: "json",
    messages: [
      { role: "system", content: buildSystemPrompt() },
      {
        role: "user",
        content:
          `App snapshot (JSON):\n\`\`\`json\n${JSON.stringify(snapshot, null, 2)}\n\`\`\`\n\n` +
          `User said: "${transcript}"\n\n` +
          `Reply with a JSON object: {"calls": [<tool_call>, ...]}. Nothing else.`,
      },
    ],
  };

  const t0 = performance.now();
  const res = await fetch(opts.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const latencyMs = Math.round(performance.now() - t0);

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${txt.slice(0, 200) || res.statusText}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[];
  };

  // Verbose log — open DevTools (Ctrl+Shift+I) to inspect when actions don't fire.
  console.debug("[voice][llm] raw response:", data);

  const msg = data.choices?.[0]?.message ?? {};
  const rawCalls = msg.tool_calls ?? [];

  let toolCalls: ToolCall[] = rawCalls
    .map((tc, i) => {
      const name = tc.function?.name;
      if (!name) return null;
      let args: Record<string, unknown> = {};
      const raw = tc.function?.arguments;
      if (typeof raw === "string" && raw.trim()) {
        try {
          args = JSON.parse(raw);
        } catch {
          // Some local models emit single-quoted JSON; try a tolerant fallback.
          try {
            args = JSON.parse(raw.replace(/'/g, '"'));
          } catch {
            args = {};
          }
        }
      } else if (raw && typeof raw === "object") {
        args = raw as Record<string, unknown>;
      }
      return {
        id: tc.id ?? `call-${i}`,
        name,
        arguments: args,
      };
    })
    .filter((c): c is ToolCall => c !== null);

  const content = typeof msg.content === "string" ? msg.content : "";

  // Fallback: many local models (mistral-nemo on Ollama, llama3, etc.) emit tool
  // calls as JSON inside `content` instead of the structured `tool_calls` field.
  // Try to extract them.
  if (toolCalls.length === 0 && content) {
    const extracted = extractToolCallsFromContent(content);
    if (extracted.length > 0) {
      console.debug("[voice][llm] extracted tool calls from content:", extracted);
      toolCalls = extracted;
    }
  }

  return {
    toolCalls,
    content,
    latencyMs,
  };
}

/**
 * Try to extract OpenAI-shaped tool calls from a model's free-text response.
 *
 * Recognised shapes (any of these, possibly inside ```json fences):
 *   {"name": "tool", "arguments": {...}}
 *   {"tool": "tool", "parameters": {...}}
 *   [{"name": "tool", "arguments": {...}}, ...]
 *   {"tool_calls": [...]}
 *
 * We scan for any JSON object/array in the text, parse it, then map it.
 */
function extractToolCallsFromContent(content: string): ToolCall[] {
  const candidates: string[] = [];

  // 1. ```json ... ``` fenced blocks
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(content)) !== null) candidates.push(m[1].trim());

  // 2. Bare JSON object or array starting at the first { or [
  const firstBrace = content.search(/[\{\[]/);
  if (firstBrace >= 0) candidates.push(content.slice(firstBrace).trim());

  for (const raw of candidates) {
    // Try whole-string parse first, then progressively shorter tails until we
    // find a valid JSON prefix (handles models that append commentary after).
    for (let end = raw.length; end > 0; end--) {
      const slice = raw.slice(0, end).trim();
      if (!slice.endsWith("}") && !slice.endsWith("]")) continue;
      try {
        const parsed = JSON.parse(slice);
        const calls = normaliseToCalls(parsed);
        if (calls.length > 0) return calls;
      } catch { /* keep scanning */ }
    }
  }
  return [];
}

function normaliseToCalls(value: unknown): ToolCall[] {
  if (Array.isArray(value)) {
    return value.flatMap((v) => normaliseToCalls(v));
  }
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;

  // Common envelopes: {"calls": [...]}, {"tool_calls": [...]}, {"actions": [...]}
  if (Array.isArray(obj.calls)) return normaliseToCalls(obj.calls);
  if (Array.isArray(obj.tool_calls)) return normaliseToCalls(obj.tool_calls);
  if (Array.isArray(obj.actions)) return normaliseToCalls(obj.actions);
  // OpenAI fn-call shape inside an array entry: {function: {name, arguments}}
  if (obj.function && typeof obj.function === "object") {
    const fn = obj.function as Record<string, unknown>;
    const name = typeof fn.name === "string" ? fn.name : null;
    if (!name) return [];
    let args: Record<string, unknown> = {};
    const a = fn.arguments;
    if (typeof a === "string") {
      try { args = JSON.parse(a); } catch { /* ignore */ }
    } else if (a && typeof a === "object") {
      args = a as Record<string, unknown>;
    }
    return [{ id: typeof obj.id === "string" ? obj.id : `call-${Date.now()}`, name, arguments: args }];
  }
  // Plain {name, arguments} or {name, parameters} or {tool, args}
  const name = typeof obj.name === "string"
    ? obj.name
    : (typeof obj.tool === "string" ? obj.tool : null);
  if (!name) return [];
  const argsField = obj.arguments ?? obj.parameters ?? obj.args ?? {};
  let args: Record<string, unknown> = {};
  if (typeof argsField === "string") {
    try { args = JSON.parse(argsField); } catch { /* ignore */ }
  } else if (argsField && typeof argsField === "object") {
    args = argsField as Record<string, unknown>;
  }
  return [{ id: `call-${Date.now()}`, name, arguments: args }];
}

/**
 * Ping the LLM endpoint AND warm the model. The first call loads the model
 * into memory (slow on cold start, fast afterwards). We pass `keep_alive: "1h"`
 * so the model stays resident for an hour of idle time.
 */
export async function pingLlm(url: string, model: string): Promise<number> {
  if (!url || !model) throw new Error("URL or model is empty.");
  const t0 = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      keep_alive: "1h",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 120)}`);
  }
  return Math.round(performance.now() - t0);
}

/** Fire-and-forget warmup — load the model into memory without blocking the UI. */
export function warmLlm(url: string, model: string): void {
  if (!url || !model) return;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      keep_alive: "1h",
      messages: [{ role: "user", content: "ok" }],
      max_tokens: 1,
    }),
  }).catch(() => { /* silent — best-effort warmup */ });
}
