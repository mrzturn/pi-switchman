---
name: git-commit-message
description: Generate convention-compliant Git commit message text from changes. Use when asked for a commit message or description, including a request to describe a batch of changes for a commit. Text only; never stage, commit, or push.
---

# Git commit message generation

**Text only:** never run `git add`, `git commit`, or `git push` as part of this skill. Deliver the message and stop; do not ask whether to commit. A separate explicit request to commit or push is outside this skill's text-only workflow.

Read `../_shared/language.md` relative to this skill directory when using this skill, and resolve the `commit` output language before asking questions or drafting. The policy's explicit-request override, layered configuration, and conversation-language fallback apply; preserve the conventional commit syntax.

## Flow

1. **Confirm the task ID first.** If the user has not supplied one, ask once for the task ID before analyzing changes. Never invent an ID. If the user explicitly declines, omit it; do not ask again in the same session.
2. **Analyze changes in scope.** Reuse the conversation context where possible. Respect the user's requested scope (for example staged only, unstaged only, untracked only, or named paths); if it is unclear which changes belong in the message, ask rather than asserting an unsupported scope. Use read-only `git status --short` to distinguish staged, unstaged, and untracked files, `git diff --cached` for staged content, and `git diff` for unstaged tracked content. A file can have both staged and unstaged changes: inspect and describe only the requested version(s). Untracked files are not included in either diff; inspect relevant untracked file contents separately when they are in scope, without staging them. If an "unstaged" request does not make clear whether untracked files are included, clarify instead of assuming. Restrict inspections to requested paths as appropriate and use `git log --oneline -5` for style when useful. Do not claim a change is staged, committed, or included in a batch without evidence; flag uninspectable changes or conflicts rather than guessing.
3. **Generate the message.** Use a concise single-line subject `<type>(<task-id>): <what was done>`, or `<type>: <what was done>` when the user declined an ID. State the result, not the process; no trailing period. Choose the type from `feat`, `fix`, `refactor`, `docs`, `test`, `perf`, `style`, `chore`. Follow with numbered body points, normally 2–4 (one if trivial), one key change per point rather than a diff restatement.
4. **Stop after delivery.** Present the message text only; do not execute a commit or push.

Example structure (translate the descriptive text into the resolved language, not the type or syntax):

```text
refactor(1024): Extract config parsing into loader module

1. Move inline parsing logic into config/loader.ts
2. Add validation for missing required fields
3. Extend tests to cover the new module
```
