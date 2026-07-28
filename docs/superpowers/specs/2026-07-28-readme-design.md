# Design: Project README

## Goal

Create a root-level English `README.md` that explains both the complete `pi-github-waves` vision and the dependency-wave graph module currently implemented, without presenting roadmap functionality as available.

## Audience

- GitHub visitors evaluating the project;
- developers consuming the graph module;
- contributors implementing later orchestration slices.

## Structure

1. **Title and concise value proposition** — describe dependency-driven GitHub Issue orchestration for pi.
2. **Project status** — prominently state that the project is in early development and that only the pure graph planner is currently implemented.
3. **Inspiration** — credit Gabriel Packer (`@gkpacker`) and link the original X post at <https://x.com/gkpacker/status/2080306086653894733>. Explain that his dependency-wave workflow inspired this GitHub Issues/pi adaptation; do not imply affiliation or endorsement.
4. **Core idea** — explain that explicit dependency edges, not ticket count, determine parallelism.
5. **Complete intended workflow** — use a GitHub-native Mermaid flowchart covering issue selection, strict validation, mandatory dry run and approval, ready-work dispatch, isolated worktrees, PR/CI/review monitoring, human merge, reconciliation, and downstream release.
6. **Wave example** — use a small Mermaid dependency graph to distinguish display levels from runtime barriers.
7. **Available today** — document the pure, no-I/O `buildDependencyWaveGraph` module and explicitly list unfinished adapters/orchestration.
8. **Graph pipeline** — use Mermaid to show validation, completion barriers, relevant active graph, Tarjan SCCs, blocker propagation, classification, and levels/batches.
9. **Usage** — provide repository setup commands using the canonical clone URL `https://github.com/lscborges1/pi-github-waves.git`, followed by `pnpm install --frozen-lockfile` and `pnpm build`. Include a TypeScript dependency-diamond example importing `pi-github-waves/graph` and show its key dispositions, levels, batches, and `runnable` result. State only that the manifest currently configures the package as private and that users should work from a repository checkout; do not claim registry publication status.
10. **Semantics/reference** — document node roles/statuses, edge direction, dispositions, runnable behavior, deterministic validation, completion barriers, cycle handling, complexity, and immutability.
11. **Safety and non-goals** — summarize human merge, no dependency inference, no mutation before approval, no I/O in the current module, and no claims that roadmap features exist.
12. **Development and roadmap** — include pnpm commands, source/test layout, and the five approved delivery slices.
13. **License/contribution note** — invite discussion and contributions while accurately stating that no open-source license has been added, avoiding interpretation of users’ legal rights, and noting that repository access remains subject to applicable law and platform terms.

## Diagram constraints

- Use only fenced `mermaid` blocks rendered natively by GitHub.
- Keep labels concise and avoid syntax that GitHub Mermaid commonly rejects.
- Provide surrounding prose so meaning is not lost if diagrams are unavailable.
- Include three diagrams: complete workflow, dependency-wave example, and current graph pipeline.

## Accuracy constraints

- Separate **Available today** and **Planned** content prominently.
- The current manifest is version `0.0.0` with `private: true`; installation instructions must direct users to a repository checkout and must not make claims about registry publication history.
- Public current API is `buildDependencyWaveGraph` plus graph contracts through `./graph`.
- The current module accepts normalized trusted TypeScript values, performs no I/O, and has no runtime dependencies.
- Broader workflow details must remain consistent with approved architecture documents under `docs/superpowers/architecture/`.
- Credit text must name Gabriel Packer, link `@gkpacker`, link <https://x.com/gkpacker/status/2080306086653894733>, and characterize it only as inspiration.

## Acceptance criteria

- A new visitor can distinguish current capability from roadmap capability within the first screen.
- The README explains why dependency-driven waves permit safe parallelism.
- All three Mermaid diagrams have valid, readable source.
- The usage example matches current exported contracts and expected output semantics.
- Commands match `package.json`.
- No unsupported installation, release, license, or affiliation claim appears.
