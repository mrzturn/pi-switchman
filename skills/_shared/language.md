# Skill output language

Read this policy when a skill needs to choose an output language. It applies to human-facing skill output, including questions, commit descriptions, document titles, headings, prose, and document type words in filenames. It does not change the skill's operational or safety boundaries.

## Resolution

1. An explicit language instruction in the user's current request wins **only for the parts it covers**. For every other part, continue through the configuration and conversation fallback below; a local override does not set the language for the rest.
2. When any part still needs a language, run the bundled helper from Pi's current working directory (not the skill directory or necessarily the repository root):

   ```bash
   node "/absolute/path/to/installed/skills/_shared/scripts/language.cjs"
   ```

   Resolve the absolute helper path relative to this `language.md`, which is linked from the loaded skill, rather than assuming a checkout or installation location. This also applies to the `db-query` skill. Do not `read`, `cat`, print, or otherwise bring either entire config file into context: they may contain keys or other secrets. The helper uses only Node.js built-ins, reads without modifying files, parses JSON locally, and emits only a JSON object of valid language fields. It reads global `${PI_CODING_AGENT_DIR}/switchman.json` when the environment variable is nonempty, otherwise `~/.pi/agent/switchman.json`, and project `<cwd>/.pi/switchman.json`.
3. In each JSON object, `skills.language` may contain the string language labels `default`, `commit`, `docs`, and `db`. Treat missing or unreadable files, malformed JSON, non-object containers, and missing, non-string, or blank values as unset. Merge **each field separately**: a valid project field overrides that same global field; otherwise retain the valid global field. The helper trims surrounding whitespace and returns `{}` if no fields are set; it does not print file contents or errors. Only put language labels in these fields.
4. For each part not covered by an explicit instruction, choose the relevant category (`commit` for git commit messages, `docs` for requirements/design documents, `db` for database skill output), then `default`. Category takes precedence over default regardless of which layer supplied it.
5. If neither is set for a part, match the language of the user's current conversation. If genuinely ambiguous, ask rather than arbitrarily defaulting to English or Chinese.

The labels can name **any** language, for example `English`, `日本語`, `fr`, or `pt-BR`; they are not an English/Chinese switch. If a valid label cannot be interpreted, ask the user to clarify. For example:

```json
{
  "skills": {
    "language": {
      "default": "English",
      "commit": "日本語",
      "docs": "fr",
      "db": "pt-BR"
    }
  }
}
```

A project `docs` value replaces only the global `docs` value, not the other fields. Resolve this policy at use time so changes to the files are reflected on the next skill invocation; no extension-side config parsing or system-prompt language marker is required.

## Translation boundary

Templates and examples define structure, not a fixed output language: translate their human-facing titles, headings, prose, and descriptive filename words into the selected language. Preserve code, paths, identifiers, commands, script arguments, protocols, conventional commit types and punctuation, gap/task IDs such as `D1` and `T1`, and the literal machine/status markers `[Decided]` and `[Pending]`. Do not translate or alter machine-readable markers, scripts, or protocols merely because a language was selected. Proper technical terms may remain as-is where appropriate.
