---
description: Run lint + tests, then commit & push (abort on failure)
argument-hint: [commit message]
---

# /ship — lint/test → commit → push

Use bash commands. If **lint** or **tests** fail, STOP and do not commit/push.

## 0) Sanity
- Run `git status --porcelain`. If empty, reply "Nothing to commit." and stop.

## 1) Decide what to run for lint + tests (in this order)
### Prefer Makefile if it exists
- If `Makefile` contains a `lint:` target → lint command is `make lint`
- If `Makefile` contains a `test:` target → test command is `make test`

### Otherwise, infer from repo tooling
**Node / JS (package.json present)**
1) Pick package manager:
   - if `pnpm-lock.yaml` → `pnpm`
   - else if `yarn.lock` → `yarn`
   - else → `npm`
2) If package.json has script `lint` → run `<pm> run lint`, else STOP with: "No lint script found in package.json"
3) If package.json has script `test` → run `<pm> run test`, else STOP with: "No test script found in package.json"

**Python**
- Lint:
  - if `ruff.toml` exists OR `pyproject.toml` contains `[tool.ruff]` AND `ruff` is available → `ruff check .`
  - else STOP with: "No Python linter found (ruff/flake8). Tell me your lint command or add one."
- Tests:
  - if `pytest` is available OR repo looks like pytest (`pytest.ini`, `tests/`) → `pytest -q`
  - else if unittest-style tests exist → `python -m unittest`
  - else STOP with: "No Python test runner found. Tell me what to run for tests."

**Go**
- Lint: if `golangci-lint` exists → `golangci-lint run ./...` else STOP
- Tests: `go test ./...`

**Rust**
- Lint: `cargo clippy --all-targets --all-features`
- Tests: `cargo test`

(If none match, STOP and ask the user what lint/test commands to run.)

## 2) Run lint, then tests
- Execute the chosen lint command. If it fails, stop and report the error output.
- Execute the chosen test command. If it fails, stop and report the error output.

## 3) Review + stage
- Run `git diff` and summarize changes in 1–2 lines.
- Run `git add -A`
- Run `git diff --staged` and sanity-check for secrets (keys, .env, tokens). If suspicious, stop.

## 4) Commit
- Commit message:
  - If `$ARGUMENTS` is provided, use it.
  - Otherwise generate a short conventional-style message based on the staged diff.
- Run `git commit -m "<message>"`

## 5) Push
- Run `git push`
- If it fails due to no upstream, run `git push -u origin HEAD`

## 6) Report
- Show current branch and `git status -sb`.
