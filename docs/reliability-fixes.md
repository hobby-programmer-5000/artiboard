# Reliability fixes proposed for 1.23.7

The changes keep a malformed request from terminating the standalone server, preserve accepted task assignments across SQLite opens, and reconcile a live board after missed changes. They also complete large reads and dependency updates, enforce the document limit after a merge, and let the same check command run on Windows.

## Review groups

| Problem | Change | Regression evidence |
| --- | --- | --- |
| URL parsing could reject outside the request handler's error boundary. | Parse inside the protected boundary and return `invalid_argument` with HTTP 400. | A disposable HTTP process answers a malformed request and then an ordinary request without restarting. |
| Every SQLite open treated a current owner/claim mismatch as legacy data. | Run that historical repair only while upgrading the pre-archive schema. The `archived_at` schema upgrade already supplies a durable boundary. | Current reassignment and version survive a second store; an older schema is repaired once and preserves subsequent reassignment. |
| Reconnect catch-up could not discover deleted rows, and an empty initial listener had no watermark. | Reconcile authoritative watched snapshots on connection recovery, tab return and offline polling. | Deleted and empty collections converge; a stale initial read cannot overwrite its replacement; changes arriving during a read survive it. |
| A limited message query could lose its newest row without discovering the next one. | Refill affected limited windows with the existing batching/debounce behavior. | Deleting the newest message or moving it earlier reveals the correct next message. |
| A whole Supabase read stopped at the API response cap. | Continue in `(collection, doc_id)` order until an empty page, using an identity cursor rather than an offset or a short-page assumption. | A capped SDK transport returns all 1,005 rows even with a 137-row cap. A real signed-in member reads 1,006 rows, including a quoted document id. |
| Completing a task queried only 200 dependents. | Continue every dependent query before constructing the existing atomic/best-effort write batches. | The shared store/MCP test finishes a task with 205 dependents and leaves none waiting on it. |
| Small patches could accumulate a document beyond the intended limit. | Check the merged document in SQLite and a forward Supabase migration; retain error index and transaction rollback. | Both backends reject an oversized merged result and roll back an earlier write in the same batch. |
| The all-checks runner tried to spawn the Windows npm shim as an executable. | Run tests with the current Node executable and report spawn errors. Use the platform's PATH delimiter and executable name in hook resolution/tests. | `npm run check` executes its test steps on Windows. Hook tests still exercise actual commit/merge/rebase behavior; POSIX mode assertions stay conditional on POSIX. |

## Design tradeoffs

Normal full-collection live updates still merge by version. Only a connection recovery, tab return, or offline poll requests an authoritative replacement, because changed-row queries alone cannot prove that an absent document was deleted. Limited query windows also refill after relevant changes; keeping only the top row cannot reconstruct the next row after a deletion. A read generation prevents an older request from replacing a newer reconciliation.

Supabase whole reads now make continuation requests. Even a short page is followed by another request, because the server can apply a cap smaller than the requested size. The unique identity order and cursor avoid offset shifts when rows are removed during paging. Realtime changes received while a snapshot loads are applied to its result.

The SQLite owner repair remains available for old schemas. A database that already has the archive column is newer than the historical holder transition and must not reinterpret claim history as a new assignment. No recurring content-based normalization or new migration table is added.

The document bound applies to the stored result of an update. An already oversized document is retained; an edit must reduce it below the existing limit. These fixes preserve the existing size-counting convention and do not change the tool schema or authorization rules.

## Upgrade and validation

SQLite upgrades on open. Supabase installations apply `20261108000000_merged_document_size.sql` with their normal migration process before relying on the merged-document guard. It replaces the current writer while preserving its grants, task guards, archive checks and version handling.

Run the ordinary gates:

```sh
npm run check
```

Run the same store/MCP regressions against an isolated Supabase stack with the repository's migrations, following the existing CI setup:

```sh
eval "$(sh scripts/supabase-env.sh)"
AB_SUPABASE=1 npm test
```

The focused tests live in `tests/regressions.test.js`, `tests/runtime.test.js` and `tests/server.test.js`. Newly added defect regressions were run against the old implementation before the fixes. The SQL size regression was also run with the old writer in the isolated database before restoring the new migration.

The capped transport test uses the installed SDK. The real-service pagination test also loads the shipped browser SDK bundle, so the page's deployed client version is covered separately from the server dependency.

Browser review uses disposable data and checks English and Korean at desktop and mobile widths. It confirms that deleting the latest message restores the older message in recent activity. This is not a claim that every proxy, Vercel path or browser engine has been tested.

## License scope

Keep the repository's existing MIT license and copyright notices. No runtime dependency or third-party source/media was added. The existing direct dependencies remain `@modelcontextprotocol/sdk` 1.32.2, `@supabase/supabase-js` 2.118.0 and `zod` 4.6.7; their installed license texts identify MIT. Their notices remain separate from the repository's license. This change does not certify all transitive dependencies or change any component's licensing terms.
