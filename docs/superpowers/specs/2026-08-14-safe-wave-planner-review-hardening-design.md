# Safe Wave Planner Review Hardening Design

## Summary

Harden the existing read-only wave planner at four trust and observability boundaries found during review. Preserve its public command, planning contracts, deterministic output, and dependency footprint.

## Scope

- Reject a GitHub issue response whose issue number differs from the requested number.
- Reject malformed GitHub timestamps that participate in completion evidence.
- Reject closure-event pagination that claims another page without advancing to a fresh cursor.
- Reject explicit ports in supported GitHub origin URLs, including default HTTPS port spellings normalized away by `URL`.
- Add a deterministic, safely redacted fingerprint to unexpected-error reporting without adding a monitoring dependency.

No graph behavior, command grammar, ticket rules, output schema, GitHub write behavior, dependency, or configuration changes are included.

## Design

### GitHub response validation

`createGitHubReadPort` remains the external JSON boundary. Its issue adapter compares the parsed response number with the requested number and throws `AdapterError("invalid_response", ...)` on mismatch. Timestamp fields are parsed with a Zod ISO-date-time schema; in particular, a malformed non-null `mergedAt` can never become completion evidence.

### Closure pagination

`planWaves` remains responsible for traversing closure pages. It records cursors already used during one issue's traversal. When `hasNextPage` is true, `endCursor` must be non-null and must not equal or repeat a cursor already used. A violation is a fatal `invalid_response`, preventing an unbounded request loop. The existing 1,000-event resource limit remains unchanged.

### Origin grammar

`parseGitHubOrigin` keeps its existing URL and identity validation. Before WHATWG URL normalization, it rejects an explicit authority port in HTTPS origins. SSH URLs continue to use the existing `url.port === ""` check. The three documented origin forms remain the only accepted forms.

### Unexpected-error reporting

The extension keeps the injectable `reportUnexpectedError` dependency. Before calling it, the extension derives a deterministic fingerprint from allowlisted error structure: the error name and stack-frame shape, excluding the error message, cause, absolute paths, issue data, and adapter output. The fingerprint is added to the structured reporting context and the default stderr event. It is diagnostic metadata only and is not persisted in the `waves-plan` entry or shown to the user.

## Test seams

Each fix uses a public seam and one red-green slice:

1. `createGitHubReadPort().getIssue()` rejects a mismatched response number.
2. `createGitHubReadPort().getClosureEvents()` rejects malformed completion timestamps.
3. `planWaves()` rejects a repeated closure cursor instead of requesting indefinitely.
4. `parseGitHubOrigin()` rejects explicit HTTPS ports.
5. The registered `/waves` command passes a deterministic redacted fingerprint to an injected unexpected-error reporter and never persists the underlying message.

After the focused tests pass, run the full test suite, typecheck, build, package dry-run, and temporary `pi -e .` smoke load. The final working tree must contain no generated files beside sources.
