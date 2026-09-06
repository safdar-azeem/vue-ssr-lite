# Browser hydration compatibility ownership

Core's browser hydration lifecycle owns `src/hydration/SsrVueHydrationAdapter.ts`.
It is explicitly version-sensitive. The supported Vue range is **3.5.x**, starting
at 3.5.0; the package's peer dependency is `~3.5.0`. Development currently resolves
3.5.40. Do not widen this minor range without updating the adapter and its tests.

The generic hydration controller owns transaction completion and disposal. The
adapter is the only code in this lifecycle that reads renderer-private state:
the mounted container's `_vnode`, component `asyncDep`/`subTree`, async wrapper
loader/resolution fields, and Suspense branches. It does not collect fetch data,
change the component tree, invoke slots, or add a wrapper component.

Vue's public mount/mounted hooks do not establish when arbitrary async setup
descendants in the initial tree have finished. Tracking only first-party hook
promises cannot discover a descendant behind an unrelated async parent or async
component loader. For now the guarded adapter preserves those ordinary Vue
applications. A future replacement needs a framework-owned registration point
that covers those parents/loaders too, without changing the public root tree.

Missing or unexpected private fields, an unmounted root, or an unsupported Vue
version cause a descriptive error. The generic controller then disposes the
initial transaction: fetch continuation records are cleared, active work is
cancelled, and deferred `server:false` work is not started. It never treats an
unknown structure as successful hydration. A deliberately deferred Vue hydration
strategy that leaves a resolved wrapper without a hydrated subtree also cannot
establish this completion contract and fails closed.

`SsrVueHydrationCompatibility.test.ts` covers sync and functional roots, async
setup descendants, async component loaders, nested Suspense, Teleport, production
operation without `app._instance`, rejection/disposal, and missing-structure
failures. `.github/workflows/vue-hydration-compatibility.yml` runs the dedicated
suite and useFetch hydration integration on both **3.5.0** and the **highest
available 3.5.x patch**. The moving upper endpoint detects new patch regressions;
the lower endpoint protects the declared minimum. Extending to another minor
requires adding its endpoints before widening the manifest and runtime guard.

This review adds the coverage and CI definition; validation results must come
from running them. No compatibility pass is implied by the source changes.
