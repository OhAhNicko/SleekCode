# CLAUDE.md

## 🚀 First-run project setup

**On first interaction in a new project**, check if the `## Project` section below has empty fields (e.g. `- Product:` with no value after the colon). If ANY field is empty, this is an unconfigured project — run this setup BEFORE doing anything else:

### Step 0: Auto-detect from existing files

Before asking questions, check for existing project files (`package.json`, `tsconfig.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.). If found, read them and pre-fill what you can. Only ask about what's missing or ambiguous.

### Step 1: Ask project type (determines all recommendations)

Use **AskUserQuestion**. First question determines best-practice defaults for the rest:

**Question 1** — "What type of project is this?" (header: "Project type")
- Options: "Web app (SPA)", "Full-stack web app (SSR)", "CLI tool", "API/backend service"
- User picks or types custom.

### Step 2: Ask remaining questions with smart recommendations

Based on Q1 answer, ask up to 3 more questions. Mark the best-practice option as **(Recommended)** — put it first in the options list.

**If Web app (SPA):**
- Stack → "React + TypeScript + Vite (Recommended)", "Svelte + TypeScript + Vite", "Vue + TypeScript + Vite"
- Backend → "Supabase (Recommended)", "Firebase", "Convex", "None yet"
- Hosting → "Vercel (Recommended)", "Netlify", "Cloudflare Pages"

**If Full-stack web app (SSR):**
- Stack → "Next.js + TypeScript (Recommended)", "Nuxt + TypeScript", "SvelteKit + TypeScript", "Remix + TypeScript"
- Backend → "Supabase (Recommended)", "Prisma + PostgreSQL", "Drizzle + PostgreSQL"
- Hosting → "Vercel (Recommended)", "Railway", "Fly.io"

**If CLI tool:**
- Stack → "Node.js + TypeScript (Recommended)", "Python", "Go", "Rust"
- Backend → "None (Recommended)", "SQLite for local storage"
- Hosting → "npm publish (Recommended)", "PyPI", "GitHub Releases"

**If API/backend service:**
- Stack → "Node.js + Express + TypeScript (Recommended)", "Python + FastAPI", "Go + Chi", "Rust + Axum"
- Backend → "PostgreSQL + Drizzle (Recommended)", "Supabase", "MongoDB"
- Hosting → "Railway (Recommended)", "Fly.io", "AWS Lambda", "Cloudflare Workers"

### Step 3: Fill in and clean up

1. **Fill in the `## Project` section** with the answers.
2. **Update `## Commands`** — read `package.json` (or equivalent) and fill in actual scripts. Remove placeholder comments.
3. **Adjust optional sections** based on stack:
   - No frontend? Remove `## UI/UX design work` and `## CSS/React gotchas`.
   - No database? Remove `## Database safety patterns`.
   - Not using Tailwind? Adjust the UI ban list (tinted badges, color bans reference Tailwind classes).
4. **Remove this `## 🚀 First-run project setup` section** from the file after setup is complete.

---

## ⛔ RULE #1: NEVER RESTORE FROM GIT WITHOUT PERMISSION

**This is the most important rule. It overrides everything else.**

- **NEVER** run `git checkout`, `git restore`, `git reset`, `git revert`, or `git stash pop/apply` without **explicitly asking the user first**.
- **NEVER** use the undo system, file-history restore, or ANY mechanism that reverts files to a previous state without **explicitly asking the user first**. This includes Claude Code's built-in undo/snapshot system.
- **NEVER** assume git history has a "good" version to restore from.
- **The working directory contains the TRUTH.** Uncommitted work is MORE RECENT than git history.
- **If something is broken, FIX IT BY EDITING.** Do not restore from git or undo.
- **If you think you need to restore or undo ANY file, ASK FIRST:** "Do you want me to restore [file]? This will overwrite any uncommitted changes."

Violating this rule destroys user work. There are no exceptions.

---

## ⛔ RULE #2: NEVER RUN CONCURRENT SESSIONS — CHECK AND WARN

- **Two Claude Code sessions on the same directory WILL destroy work.** Concurrent sessions + user interruptions can trigger the file-history undo system, which reverts modified files to git HEAD — uncommitted work is permanently lost.
- **Before writing to any file, re-read it first.** If the content differs from what you last read, **STOP** and tell the user — another session may have modified it.
- **Never assume your in-context file content is current.** Another Claude session may be editing the same repo concurrently.
- If you detect a conflict, show the user what changed and ask how to proceed.
- **If you suspect concurrent sessions are active, REFUSE to proceed** until the user confirms only one session is running.

---

## Project
- Product: EzyDev — AI terminal workspace (Warp/BridgeSpace-inspired)
- Stack: Tauri v2 + React 19 + TypeScript + Vite + Tailwind CSS 4
- Backend/DB: Local (Zustand persist to localStorage), future Supabase/Convex sync
- Auth: None (desktop app, no auth needed for MVP)
- Hosting: Desktop-only (native Windows app via Tauri)

## Terminal
- Environment: WSL2 (Ubuntu 24.04), bash (WezTerm)
- Use bash-compatible commands (avoid PowerShell syntax unless explicitly requested)
- Prefer `npm` unless the repo indicates otherwise
- Windows paths in WSL: `C:\Users\...` → `/mnt/c/Users/...` (screenshots, clipboard files, etc.)

## WSL ↔ Windows workflow (IMPORTANT)
- Claude Code runs in WSL. Tauri compiles a native Windows app via Windows cargo (MSVC target).
- `npm install` from WSL creates Unix shims only → `npm run tauri` FAILS on Windows PowerShell.
- **To launch Tauri**: use `npm run tauri:dev` from WSL — it delegates to Windows PowerShell automatically.
- **Frontend-only work** (editing, typecheck, vite build): runs fine from WSL directly.
- **Never run `npm run tauri dev`** from WSL — it would try Linux cargo and fail.
- Helper scripts: `scripts/tauri-dev.sh`, `scripts/tauri-build.sh` handle the WSL→Windows bridge.

## Commands
- Frontend dev server: `npm run dev` (Vite on :1420, WSL OK)
- Frontend build: `npm run build` (tsc + vite build, WSL OK)
- Type-check: `npm run typecheck` (WSL OK)
- **Tauri dev**: `npm run tauri:dev` (WSL → bridges to Windows PowerShell)
- **Tauri build**: `npm run tauri:build` (WSL → bridges to Windows PowerShell)
- Preview build: `npm run preview` (WSL OK)

## Core principles
- Read relevant files before answering questions about the codebase.
- Do not invent files, scripts, APIs, commands, or project details. Verify by reading.
- Prefer minimal, incremental and reversible changes / improvements over large rewrites (small diffs, small surface area).
- Preserve existing architecture and conventions (patterns - naming, structure, error handling) unless explicitly asked to change them.
- Do not add dependencies unless explicitly requested.
- If uncertain, state what you checked and what is unknown; ask when needed.
- Never speculate about code you have not opened. If I reference a specific file, you MUST read it before answering.
- Never make claims about the code before investigating unless you are certain the claim is correct—give grounded, hallucination-free answers.
- Questions are not requests. When say it's a question or ask "why", "what", or "how" -  explain, don't change code.
- Before implementing non-trivial changes, interview me using AskUserQuestion about ambiguities, tradeoffs, edge cases, and design decisions. Skip obvious questions - focus on things that could reasonably go multiple ways.
- **ALWAYS use AskUserQuestion for ambiguous layout/positioning requests** — "reduce the gap", "make it 32px", "content size" are all ambiguous. ASK which gap, which dimension, what should/shouldn't change BEFORE writing code.
- **ALWAYS persist AskUserQuestion decisions IMMEDIATELY** — whenever the AskUserQuestion tool is used and the user answers, append BOTH the question AND the user's answer to `docs/session-prompts.txt` right away (before doing anything else). Context compaction can lose these decisions permanently. Format: `[AskUserQuestion] Q: <question> → A: <answer>`.
- **NEVER remove existing UI elements without being asked** — when rewriting a component, preserve all visual features (chevrons, indicators, etc.) unless explicitly told to remove them.

## Git safety (see Rule #1 above)
- All git restore/checkout/reset operations require explicit user permission.
- Read Rule #1 at the top of this file before any git operation that modifies files.
- **NEVER use `git stash` mid-session to probe pre-existing errors** — stash pop can fail due to unrelated changes, leaving working-tree changes inaccessible. Instead, just run `tsc --noEmit` with changes in place and note which error lines you didn't touch.

## Updating the EzyDev voice server (Mac mini)

The voice agent (push-to-talk + intent → action) calls a small FastAPI service on the user's Mac mini. The server is **separate from** the podcast app's `podd-ad-server` and lives at `~/projects/ezydev-voice-server/server.py` on the Mac mini, listening on **port 8770**. It exposes:

- `GET /health` → `{"status":"ok","whisper_model":"..."}`
- `POST /transcribe` (multipart `file`, optional `language`) → `{"text","language"}`  — backed by MLX Whisper
- `POST /v1/chat/completions` (OpenAI-compat passthrough) → forwards to local Ollama on `127.0.0.1:11434`

We never edit the Mac mini directly — we follow the same 5-step workflow as the podcast project.

### 5-step workflow

1. **Edit local working copy** at `/tmp/ezydev_voice_server.py` using Edit/Write tools. Never edit the Mac mini's `server.py` directly.
2. **Syntax-check**:
   ```bash
   python3 -c "import ast; ast.parse(open('/tmp/ezydev_voice_server.py').read()); print('syntax ok')"
   ```
3. **Upload to temp.sh**:
   ```bash
   curl -sF "file=@/tmp/ezydev_voice_server.py" "https://temp.sh/upload"
   ```
   Returns a URL like `https://temp.sh/ABCDE/ezydev_voice_server.py`.
4. **Hand the user the deploy one-liner** (template below) with the temp.sh URL substituted in.
5. **User runs it on the Mac mini**, verifies `/health` returns ok JSON.

### Deploy one-liner template

**The EzyDev voice server runs in its own isolated venv at `~/projects/ezydev-voice-server/.venv/`** so it can't be broken by changes to the podcast server (or vice versa). MLX Whisper is reinstalled into that venv on first deploy (~3 minutes); subsequent deploys reuse the cached venv and take seconds.

Substitute `<TEMPSH_URL>` with the URL from step 3. The template covers two cases:

**First deploy (no `.venv` yet) — slow path, ~3 minutes:**
```bash
mkdir -p ~/projects/ezydev-voice-server && cd ~/projects/ezydev-voice-server && curl -fsSL -X POST <TEMPSH_URL> -o server.py && head -1 server.py | grep -q '^"""' && python3 -c "import ast; ast.parse(open('server.py').read())" && python3 -m venv .venv && .venv/bin/pip install --quiet --upgrade pip && .venv/bin/pip install --quiet fastapi uvicorn python-multipart httpx mlx-whisper && pkill -f "uvicorn server:app --port 8770" 2>/dev/null; nohup .venv/bin/python -m uvicorn server:app --host 0.0.0.0 --port 8770 > server.log 2>&1 & sleep 180 && curl -s http://127.0.0.1:8770/health && echo
```

**Subsequent deploys (venv already exists) — fast path, ~5 seconds:**
```bash
cd ~/projects/ezydev-voice-server && curl -fsSL -X POST <TEMPSH_URL> -o server.py && head -1 server.py | grep -q '^"""' && python3 -c "import ast; ast.parse(open('server.py').read())" && pkill -f "uvicorn server:app --port 8770" 2>/dev/null; nohup .venv/bin/python -m uvicorn server:app --host 0.0.0.0 --port 8770 > server.log 2>&1 & sleep 4 && curl -s http://127.0.0.1:8770/health && echo
```

Both paths verify the downloaded file is actually Python (line 1 starts with a `"""` docstring) and pass `ast.parse` BEFORE killing the running server — fail-fast prevents replacing a working server with a broken one.

Expected last line:
```
{"status":"ok","whisper_model":"mlx-community/whisper-large-v3-turbo"}
```

### Critical gotchas

- **`curl` MUST use `-X POST` against temp.sh URLs.** A plain GET returns an HTML "click here to download" landing page that silently overwrites `server.py`. Symptom: uvicorn dies with `SyntaxError: invalid decimal literal` pointing at a line like `font-size: 18px;` in `server.log` — that's Python trying to parse CSS. The one-liner above uses `curl -fsSL -X POST <TEMPSH_URL> -o server.py` plus a `head -1 ... grep '^"""'` check that fails fast if the download is still HTML. Never weaken either guard.
- **temp.sh URLs expire.** If you re-run a one-liner hours later and the `head` check fails, re-upload (step 3) to get a fresh URL.
- **Isolated venv at `~/projects/ezydev-voice-server/.venv/`.** Do NOT share the podcast server's venv — that re-couples the two projects. First deploy installs `mlx-whisper` into the EzyDev venv (~3 min, ~2 GB disk); subsequent deploys reuse it instantly.
- **System Python is blocked by PEP 668 on this Mac mini** (Homebrew Python 3.14). That's why we use a venv, not `pip install --user`.
- **Use port 8770, not 8765.** 8765 is the podcast server. Never touch that.
- **The fail-fast checks (`head` + `ast.parse`) come BEFORE `pkill`.** If the new file is broken, the running server keeps running. Order matters; don't reorder them.
- **The download filename matters.** `curl ... -o server.py` writes directly to `server.py`. If you change to `-O` (capital, "save as remote name"), you also need a `mv` step.
- **First `/transcribe` call downloads ~1.5 GB Whisper model weights.** That's normal, one-time, cached at `~/.cache/huggingface/`.
- **`pkill` before `nohup`** is intentional and idempotent — re-running the one-liner replaces the running instance instead of stacking duplicates.
- **Verify from the Windows machine** after deploy: `curl http://<mac-mini-tailscale>:8770/health` must succeed before EzyDev's "Test" buttons will go green.
- **EzyDev settings** after a successful deploy:
  - Whisper URL: `http://<mac-mini-tailscale>:8770/transcribe`, format **Custom**
  - LLM URL:     `http://<mac-mini-tailscale>:8770/v1/chat/completions`
  - Model:       whatever Ollama has pulled (`mistral-nemo` is the user's current pick — handles Swedish well; tool-calling requires Ollama ≥ 0.4)
- **Streaming is disabled in EzyDev's LLM client** (`stream: false`), so the chat-completions handler is a single forward-and-return. Don't add SSE complexity unless EzyDev's client changes.
- **Do NOT extend `podd-ad-server/server.py`** to host EzyDev endpoints. The two services stay isolated so podcast-server changes can never break voice and vice versa.

## /ship commits - CRITICAL
- **ALWAYS chain `git add -A && git commit` in ONE command** to prevent race conditions with file watchers/HMR
- **ALWAYS run `git status` after commit** to verify working tree is clean before pushing
- If files remain uncommitted after commit, add and commit them before pushing
- Never push until `git status` shows "nothing to commit, working tree clean"

## First steps in any repo
1) Identify the toolchain and how work is done:
   - package/build files, task runners, CI configs, container/dev-env configs.
2) Find entry points:
   - app start, CLI main, server handler, or primary executable.
3) Find how to verify changes:
   - build, tests, lint/format, type-check/static analysis (if present).
4) Read any existing documentation. Do not assume documentation exists.

## UI/UX design work
<!-- Adjust banned patterns per project. These are battle-tested defaults. -->
- **All visual UI/UX changes MUST use the `frontend-design` skill / plugin.** This includes: component styling, layout changes, animations, hover states, color/theme adjustments, spacing tweaks, and any design polish work — even "tiny" CSS changes. Do not attempt UI/UX fixes without invoking the skill first.
- **NEVER use soft/tinted badges** (`bg-red-500/10 text-red-400` translucent style). Always use **solid opaque backgrounds** with white/light text (e.g. `bg-red-600 text-white`, `bg-neutral-700 text-white`). Applies to all badges, chips, pills, action buttons, tag elements, AND success/warning/info banners.
- **NEVER use pulsating/ping animations** (`animate-ping`, `animate-pulse`) — annoying for users. Use static indicators or single-fire animations only.
- **NEVER use emojis in the UI** — no emoji characters in rendered components. Use inline SVG icons instead.
- **NEVER use dashed borders** (`border-dashed`) for empty states or CTAs — looks dated. Use solid borders at reduced opacity instead.
- **NEVER use per-tier colored card backgrounds** (rainbow cards) — cards should share a uniform neutral surface. Differentiate tiers via badge accent color only (monochrome escalation).
- **NEVER use `font-mono` at small font sizes** (text-[9px], text-[10px], etc.) — unreadable. Use default/system font with `tabular-nums` if alignment is needed.
- **NEVER use amber/yellow/blue colors** (no `amber-*`, `yellow-*`, `blue-*` Tailwind classes) — use white, neutral, emerald, red, cyan, or other palette colors instead.
- **UI compliance audit on every file edit** — when modifying ANY `.tsx` file, scan the ENTIRE file for banned patterns (tinted badges, emojis, banned colors, dashed borders, `animate-pulse/ping`, `font-mono` at small sizes) BEFORE finishing. Existing code in the same file can violate rules too.
- **Tab switch must scroll to top**: Every `setView`/`setActiveTab` handler must include `window.scrollTo(0, 0)`.
- **Pagination must scroll to top**: Every page-change handler in pagination controls must include `window.scrollTo(0, 0)`.

## CSS/React gotchas
- **`background-clip: text` breaks on React re-render in Chromium** — when a component using gradient text receives new props, the clip mask doesn't re-paint. Fix: add `key={uniqueId}` to force remount.
- **`<button>` elements inflate compact headers** — buttons inherit `line-height: 1.5`, making a `w-4 h-4` SVG button 24px instead of 16px. Use bare `<svg onClick>` in compact headers to avoid invisible height inflation.
- **`replace_all` (Claude Edit tool) is indentation-sensitive** — if two instances of a string differ only by leading whitespace, `replace_all` may only match one. Always re-read the file after `replace_all` to verify all instances were caught.
- **Card-with-header pattern needs `overflow-hidden`** — when global border-radius CSS applies to ALL divs, a header div inside a card gets its own rounded bottom corners, creating a visible gap. Fix: add `overflow-hidden` on outer card to clip child elements to the card shape.

## Database safety patterns
<!-- General patterns — applicable to any SQL/RPC-based backend -->
- **NEVER use read-modify-write for balance/counter columns** — use atomic SQL operations (e.g. `SET balance = balance + $1`) to prevent race conditions.
- **Fallible operation FIRST, then money**: for purchases, do the INSERT/UPDATE (might fail) BEFORE deducting balance. Never deduct money before the fallible operation.
- **Status updates BEFORE processing**: in batch resolvers, mark the record as processed FIRST, then do mutations. Prevents double-processing on retry.
- **RPCs that insert records MUST have idempotency guards** — the caller may invoke them twice. The RPC itself must check for existing output before processing.
- **NEVER write DB queries from memory** — always verify column/table names against existing code or the actual schema BEFORE writing. Copy the pattern from nearby working code; don't guess.
- **When inserting into existing tables, CHECK ALL NOT NULL columns** — silent failures from missing NOT NULL columns with no default are invisible and can go unnoticed for weeks.
- **NEVER expose UUIDs in URLs** — use sequential integer columns (`match_number`, `player_number`, etc.) for all public-facing routes. UUIDs stay internal.

## Planning workflow (for anything non-trivial)
- If missing, create: `tasks/todo.md`, `docs/architecture.md`, and `docs/learnings/` (and the learnings file you write).

1) Think through the problem and read relevant codebase files.
2) Write a short plan to `tasks/todo.md` as checkboxes.
3) If the plan is major/risky, pause and ask me to confirm before implementing.
4) Implement step-by-step, ticking items as you go.
5) Add a short "Review" section at the end of `tasks/todo.md` summarizing what changed.

## Progress updates
- Provide high-level notes as you go (what changed and why), especially on multi-step tasks.

## Architecture documentation
- Maintain `docs/architecture.md` describing the app structure at a high level.
- Create it if it doesn't exist.
- Update it when architectural decisions or data flow change.

## Learnings
- After resolving a non-trivial bug/incident or when /end command is sent, capture learnings in:
  `docs/learnings/YYYY-MM-DD-<short-title>.md`
- Include: Summary, Symptoms, Root cause, Fix, Prevention, Verification.
- Create `docs/learnings/` if it doesn't exist.

## Testing & validation (before committing)
1) Run `npm run build` (if it exists; otherwise use the repo's build command)
2) If lint exists: run `npm run lint`
3) If type-check exists: run `npm run type-check`
   - If `tsconfig.json` exists and there is no type-check script: run `npx tsc --noEmit`
4) If UI changed: open the app and confirm:
   - no console errors
   - Network tab has no failed requests
5) If auth/roles exist: test key flows as both logged-in and logged-out users (and admin/non-admin if applicable)

## Verification
- Default: run the repo's primary build command (often `npm run build`)
- If dependencies may be out of date: run `npm install` first
- If UI/routing changed: include a short manual test plan (URLs to visit)

## Output format (for non-trivial changes)
1) Summary (bullets)
2) Files changed
3) How to verify (exact commands)
4) Manual test plan (if applicable)
5) Risks / edge cases (if any)

## Command triggers
When I write…

### CMD: PATCH
- Fix with a minimal diff.
- Preserve architecture and style.
- Include verification steps.

### CMD: REFACTOR
- Keep behavior identical.
- Reduce duplication / improve readability.
- Call out any risk.

### CMD: ROUTE
- Keep routing changes consistent with the existing router setup.
- Update links/nav and any 404 handling if needed.
- Provide a URL-based manual test plan.

### CMD: DOCS-SYNC
- Update README/docs/examples to match current conventions and scripts.
- Remove or flag outdated guidance.

### CMD: LEARNINGS
- Write a learnings doc to `docs/learnings/YYYY-MM-DD-<short-title>.md`
- Use sections: Summary, Symptoms, Root cause, Fix, Prevention, Verification.

### CMD: JUST-THE-DIFF
- Output only: files changed, key snippets, and verification commands.

### /lesson
- Capture learnings from the current conversation in a markdown file
- File: `docs/learnings/YYYY-MM-DD-<short-title>.md`
- Include: Summary, Symptoms, Root cause, Fix, Prevention, Verification
- **If a major bug or important gotcha was discovered**, save a concise one-liner to `MEMORY.md` to prevent repeating it

### /ship [commit message]
- Run lint + tests, then commit, push, and deploy (abort on failure)
- **CRITICAL: Always commit ALL available changes, not just feature-specific files**
1. Sanity: `git status --porcelain` - if empty, stop
2. Run lint (infer from Makefile or package.json scripts)
3. Run tests (infer from Makefile or package.json scripts)
4. If either fails, STOP and report errors
5. `git add -A` (stage ALL changes), check for secrets
6. Commit with provided message or generate conventional-style message
7. `git push` (or `git push -u origin HEAD` if no upstream)
8. Report: branch, `git status -sb`

### /end
- Session wrap-up workflow
1. Verify work: best practices, efficiency, security, build/tests/lint pass
2. Check if anything needs to go into the plan file
3. Create learnings doc: `docs/learnings/YYYY-MM-DD-<short-title>.md`
   - Write it with the same depth and quality as `/lesson` — not a surface-level summary
   - If there were bugs or failed attempts, explain the faulty reasoning behind each attempt and why it failed
   - The goal is to prevent repeating the same mistakes — a one-liner like "three attempts failed" is useless; explain WHY they failed
   - Include: Summary, Symptoms, Root cause (with full debugging story if applicable), Fix, Prevention, Verification
4. **If a major bug or important gotcha was discovered**, save a concise one-liner to `MEMORY.md` to prevent repeating it
5. Append all USER prompts from this session to `docs/session-prompts.txt`
   - Format: numbered messages with date/session header
   - Only user messages, not Claude responses
