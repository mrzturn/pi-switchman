# Document templates

Choose the skeleton appropriate to the document type and task; keep the numbering and heading style consistent throughout. These examples describe structure, not the output language: render human-facing text in the language selected by `../../_shared/language.md`. Keep literal `[Decided]`, `[Pending]`, `D1`, `T1`, code, and paths unchanged. Apply the four core principles in `../SKILL.md`; adapt sections that do not fit rather than inventing facts. For a PRD, architecture, API design, or technical plan, adapt the closest skeleton to the requested document and its audience.

## Design document (primary template)

For technical changes to an existing system. Name it `yyyy-mm-dd-<module>-<type>.md`, with the type word in the document language.

````markdown
# {Module} — {Business} design

> Version: v1.0    Date: yyyy-mm-dd    Related modules: `service-a`, `service-b`
>
> **Confirmed decisions (yyyy-mm-dd):**
> - **[Decided] {Decision 1}**: {Conclusion}.
> - **[Decided] {Decision 2}**: {Conclusion, including key bypass/reuse/rollback actions}.

## 1. Requirements overview

Explain the problem and what is added or changed in the existing logic. List the core capabilities, highlighting key terms.

## 2. Current-state analysis (with code evidence)

### 2.1 Key call chain

Trace entry to core logic with `file:line` and method context:

```text
Controller.xxx()                       // XxxController.java:123
  └─ ServiceImpl.xxx()                 // XxxServiceImpl.java:456
       └─ [callback] YyyServiceImpl.zzz() // YyyServiceImpl.java:101
            ├─ existingMethodA()       // :160  change point
            └─ existingMethodB()       // :170  swallowed exception
```

Explain where post-processing really happens, which exceptions are swallowed, and which code is commented out or obsolete, when supported by evidence.

### 2.2 Existing logic inventory

| Block | Trigger | Logic | Impact on requirement |
|---|---|---|---|
| Logic A | Condition A | What it does | Reusable / needs modification |

### 2.3 Reference implementations (if any)

Identify existing analogous implementations, their locations, behavior, and differences, including those at another entry point. Avoid reinventing them.

### 2.4 Current tables, APIs, and enums

| Concern | Current state | Impact |
|---|---|---|
| A query | Absent from the repository | Needs adding |

## 3. Gap comparison

| # | Gap | Current state | Requirement |
|---|---|---|---|
| D1 | Scope | Write table only | Write table and dispatch |
| D2 | Lookup basis | Line-side warehouse | Warehouse on each detail row |

## 4. Technical solution

Address each gap and identify the corresponding IDs in subsection headings.

### 4.1 {Core challenge} (D1/D2)

**Problem:** explain the difficulty, such as timing or consistency.
**Solution:** specify the change and cite `file:line` and method; optionally show before/after code or pseudocode.
> Caution: {point requiring confirmation or care}.

## 5. Data sources

Specify exact entity/field sources. Compare ambiguous alternatives and recommend a lean:

1. **[Decided] Field A:** from `Entity.field`. Verify null fallback before implementation.
2. **[Pending] Field B:** option 1 `create_time` (simple) / option 2 `MIN(create_time)` (precise, requires JOIN). Recommend option 1; confirmation required.

## 6. Impact and risks

Every risk has a mitigation:

| Risk | Explanation | Mitigation |
|---|---|---|
| Concurrent access | Simultaneous requests | Roll back real failures, log for manual handling |
| Timing window | State changes between check and execution | Soft pre-check; rely on atomic operation |

## 7. Questions requiring confirmation

Confirmed decisions also appear at the top; list them and open questions here. Every pending item needs a lean:

1. **[Decided] {Point 1}:** {Conclusion}.
2. **[Pending] {Point 2}:** {Question}? Recommendation: {lean}.

## 8. Implementation overview

Show the changed call structure and a list of new/modified files grouped by service, with one responsibility per file.

## Appendix A: Key files and lines

| Content | Location |
|---|---|
| Entry point | `XxxController.java:123` (`entryMethod`) |
| Reference implementation | `YyyServiceImpl.java:300-400` (`sampleMethod`) |
| Status enum | `XxxStatusEnum.java` |
````

## Requirements analysis (lightweight template)

For clarifying what to build, why, and how completion is measured. For legacy changes retain the evidence-backed current state; for a purely new feature the gap table may be omitted.

````markdown
# {Module} — {Business} requirements analysis

- Date: yyyy-mm-dd    Status: draft / in review / confirmed

## 1. Requirements overview

Problem and delivered value.

## 2. Background and current state

How it works today, with `file:line` and method evidence; pain points and why change now.

## 3. User roles and scenarios

Roles and typical paths through the system.

## 4. Functional requirements

Number items by module; specify input, processing, and output.

## 5. Non-functional requirements

Performance, security, compatibility, and observability.

## 6. Acceptance criteria

Testable completion criteria, using a checklist or Given-When-Then.

## 7. Questions requiring confirmation

1. **[Pending] {Point}:** {Question}? Recommendation: {lean}.

## 8. Out of scope

Explicitly state what will not be done.

## Appendix A: Key files and lines

List evidence with `file:line` and method/context.
````

## Development plan

For turning a design into executable tasks.

````markdown
# {Module} — {Business} development plan

- Date: yyyy-mm-dd    Status: in progress / partially complete / complete
- Related design: `docs/requirements-and-design/yyyy-mm-dd-module-design.md`

## 1. Goal

One-sentence goal.

## 2. Task breakdown

Group by gap ID or phase and use checkboxes:

### Phase 1: Pre-validation (design D1/D4)
- [ ] T1 Add `checkXxx()` in `approve()` (file: `XxxServiceImpl.java`)

## 3. File structure

List new and modified files, one responsibility each.

## 4. Dependencies and order

What must precede other work and what can run in parallel.

## 5. Milestones and acceptance

Deliverables verifiable at each phase.

## 6. Risks

Refer to the design's risks and state how this plan mitigates them.

## Appendix A: Key files and lines

List evidence with `file:line` and method/context.
````
