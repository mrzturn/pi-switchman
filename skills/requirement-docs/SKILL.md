---
name: requirement-docs
description: Draft or reorganize requirements analysis, PRDs, design, architecture, API design, technical plans, or development plans. Use before creating or restructuring such documents; research the existing system and follow the shared archive and document structure, without writing files for read-only requests.
---

# Requirements and design document spec

Goal: centralized archiving, unified naming, consistent structure, and understanding existing code before proposing solutions.

Read `../_shared/language.md` relative to this skill directory when using this skill, and resolve the `docs` output language before asking questions or drafting. Read `references/templates.md` relative to this skill directory before drafting; its templates define structure, not a fixed language. Translate human-facing content into the resolved language while preserving the literal markers and identifiers specified in the shared policy.

## Flow (every time)

1. Locate the repository root and inspect existing documentation and archive files for naming collisions and style drift. Use the existing requirements/design archive directory if present; otherwise use `docs/requirements-and-design/` at the repository root. Create the directory only when writing is permitted and needed.
2. Choose `yyyy-mm-dd-<module>-<type>.md`: today's date, a kebab-case module, and a type word in the document's language. Types include requirements, PRD, design, architecture, API design, technical plan, and development plan. For example, an English design could be `docs/requirements-and-design/2026-09-05-config-loader-design.md`. Avoid overwriting an existing file; choose a non-conflicting name.
3. Research before proposing or writing: read relevant code, `docs/`, `README`, applicable `AGENTS.md`, and key entities/services. Ground claims in what was actually inspected; mark unverified facts as pending rather than inventing evidence.
4. Select a skeleton from `references/templates.md`, adapt it to the document type and task, and apply the core principles below. Self-check the date, type word, consistent section numbering/style, `[Decided]`/`[Pending]` markers, and appendix. When writing is allowed and appropriate, write the document in the archive and report its path.

**Read-only requests:** if the user asks for analysis or a document without writing files, do not create directories or write, edit, or overwrite any file. Perform the research with read-only operations and present the document in the response instead; a suggested archive path may be included without creating it. Follow any more restrictive user instructions.

## Core principles (legacy-system methodology)

1. **Evidence-backed current state:** trace call chains from entry points (Controller/API/CLI) to core logic with `file:line` and method context; identify reusable assets, reference implementations, and pitfalls such as swallowed exceptions or hardcoding. Avoid unsupported background statements.
2. **Current state → gaps → solution:** analyze the current state first, then compare numbered gaps `D1`, `D2`, etc. (current versus required); reference the gap IDs in the solution. For a purely new feature, a requirements analysis may omit the gap table where it is not useful.
3. **Honest `[Decided]`/`[Pending]` split:** put confirmed decisions and confirmation dates in a quote block at the top; give open questions their own section and a recommended lean for each. Never present pending as decided. Every risk needs a mitigation.
4. **Field-level clarity and appendix:** identify the exact entity/field supplying key data; compare ambiguous alternatives and recommend one; end with a `file:line` quick-reference table.

## Writing rules

- Wrap code, paths, and field names in backticks.
- Prefer Mermaid or indented code blocks for call chains, sequences, and flows; no external images.
- Explain reasons for decisions, not just conclusions.
- With `file:line` citations include the method name or context to help survive line drift.
