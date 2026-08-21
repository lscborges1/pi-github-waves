# GitHub Wave Orchestration

This context describes how explicitly selected GitHub work becomes a safe, dependency-aware execution plan for local agents.

## Language

**Selected issue**:
A GitHub Issue explicitly requested for planning and possible future execution.
_Avoid_: Ticket in scope, requested node

**Boundary blocker**:
An unselected Issue loaded only because it blocks selected work. It provides planning context and is never dispatched by that plan.
_Avoid_: External task, implicit selection

**Completion evidence**:
A closing pull request merged into the repository's default branch whose merge commit remains in that branch's current history.
_Avoid_: Closed issue, done label

**Completion barrier**:
A blocker with verified completion evidence that stops dependency traversal and propagation above it.
_Avoid_: Completed ancestor traversal

**Wave**:
A deterministic display level grouping selected issues by dependency depth. It explains a plan but is not a runtime barrier.
_Avoid_: Phase, execution batch

**Ready issue**:
A selected, eligible issue with no unresolved blocker of its own.
_Avoid_: First-wave issue

**Runnable plan**:
A plan with valid selected work and no invalid, cyclic, or unresolved boundary condition that prevents safe execution.
_Avoid_: Valid partial plan
