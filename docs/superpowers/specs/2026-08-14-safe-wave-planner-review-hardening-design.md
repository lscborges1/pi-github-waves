# Safe Wave Planner Review Hardening Design

## Summary

Harden the existing read-only wave planner at four trust and observability boundaries found during review. Preserve its public command, planning contracts, deterministic output, and dependency footprint.

## Scope

- Reject a GitHub issue response whose issue number differs from the requested number.
- Reject malformed GitHub timestamps that participate in completion evidence.
- Reject closure-event pagination that claims another page without advancing to a fresh cursor.
- Reject explicit ports in supported GitHub origin URLs, including default HTTPS port spellings normalized away by `URL`.
- Add a deterministic, safely redacted error signature to unexpected-error reporting without adding a monitoring dependency.

No graph behavior, command grammar, ticket rules, output schema, GitHub write behavior, dependency, or configuration changes are included.

## Design

### GitHub response validation

`createGitHubReadPort` remains the external JSON boundary. Its issue adapter compares the parsed response number with the requested number and throws `AdapterError("invalid_response", ...)` on mismatch.

The adapter parses these external timestamp fields as RFC 3339 date-times with either `Z` or a numeric UTC offset: issue `created_at`, issue `updated_at`, closure-event `createdAt`, and non-null pull-request `mergedAt`. A date-only value, local date-time without an offset, or otherwise malformed value produces `invalid_response`; in particular, malformed `mergedAt` data can never become completion evidence.

### Closure pagination

`planWaves` remains responsible for traversing closure pages. It records cursors already used during one issue's traversal. When `hasNextPage` is true, the page must contain at least one event and `endCursor` must be non-null and must not equal or repeat a cursor already used. A violation is a fatal `invalid_response`. Every continuing page therefore advances both the cursor and the event count, so the existing 1,000-event resource limit also bounds the number of requests without adding a second numeric limit.

### Origin grammar

`parseGitHubOrigin` keeps its existing URL and identity validation. Before WHATWG URL normalization, it rejects an explicit authority port in HTTPS origins. SSH URLs continue to use the existing `url.port === ""` check. The three documented origin forms remain the only accepted forms.

### Unexpected-error reporting

The extension keeps the injectable `reportUnexpectedError` dependency. Before calling it, the extension derives an `errorSignature` with this exact algorithm:

1. Use `error.name` only when it matches `[A-Za-z][A-Za-z0-9]{0,63}`; otherwise use `UnknownError`. Non-`Error` thrown values also use `UnknownError`.
2. For an `Error` with a stack, discard the first line because it contains the message. From the remaining lines, collect at most five terminal frame locations matching an ASCII basename plus decimal line and column, such as `index.js:42:7`. Discard function names, directory components, URLs, and non-matching lines. If no frame matches, use `no-stack`.
3. Join the safe name and frame locations with `|`, hash the UTF-8 bytes with SHA-256, and use the first 16 lowercase hexadecimal characters.

The signature is added to the structured reporting context and the default stderr event. The default event continues to exclude the error message, cause, absolute paths, issue data, and adapter output. A small exported reporting helper provides the production stderr seam; the command seam proves injected reporters receive the same signature.

This error signature is internal, non-authoritative observability metadata for grouping failures. It is not the deferred planner/approval fingerprint, is not part of `PlanResultV1` or the durable entry schema, is never shown to the user, and cannot affect planning behavior.

## Test seams

Each fix uses a public seam and one red-green slice:

1. `createGitHubReadPort().getIssue()` rejects a mismatched response number.
2. `createGitHubReadPort()` rejects malformed values for each enumerated timestamp field, including completion timestamps.
3. `planWaves()` rejects a repeated closure cursor and a continuing empty page instead of requesting indefinitely.
4. `parseGitHubOrigin()` rejects explicit HTTPS ports.
5. Table-driven tests of the reporting helper prove the signature is 16 lowercase hexadecimal characters, is unchanged when only the error message or absolute directory prefix changes, and uses the defined fallback for missing or nonstandard stacks. The default stderr seam includes the signature and excludes the message and absolute paths. The registered `/waves` command passes the same signature to an injected reporter and never persists the underlying message.

After the focused tests pass, run the full test suite, typecheck, build, package dry-run, and temporary `pi -e .` smoke load. The final working tree must contain no generated files beside sources.
