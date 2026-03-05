Run lint + tests, then commit, push (abort on failure).
CRITICAL: Always commit ALL available changes, not just feature-specific files.

1. Sanity: `git status --porcelain` - if empty, stop
2. Run lint (infer from Makefile or package.json scripts)
3. Run tests (infer from Makefile or package.json scripts)
4. If either fails, STOP and report errors
5. `git add -A` (stage ALL changes), check for secrets
6. Commit with provided message ($ARGUMENTS) or generate conventional-style message
7. `git push` (or `git push -u origin HEAD` if no upstream)
8. Report: branch, `git status -sb`

CRITICAL: Always chain `git add -A && git commit` in ONE command to prevent race conditions with file watchers/HMR. Always run `git status` after commit to verify working tree is clean before pushing. Never push until `git status` shows "nothing to commit, working tree clean".
