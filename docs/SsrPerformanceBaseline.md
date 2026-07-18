# SSR performance baseline and measurement protocol

## Current baseline status

No trustworthy pre-migration ERP measurement artifact exists in the inspected repositories. During this implementation, project policy explicitly prohibited build, dev, test, benchmark, network, and deployment commands. Therefore every requested pre-change metric is recorded as **not measured**, not estimated:

| Metric | Pre-change ERP result |
| --- | --- |
| TTFB | Not measured |
| Complete SSR render duration | Not measured |
| Domain resolution duration | Not measured |
| GraphQL duration/count | Not measured |
| Apollo cache size | Not measured |
| HTML/JavaScript payload size | Not measured |
| Hydration duration/duplicate requests | Not measured |
| Idle/repeated-request memory | Not measured |
| Concurrent throughput | Not measured |
| Error response duration | Not measured |

No performance multiplier or improvement claim is made.

## Built-in collection

Every SSR response emits `Server-Timing` values for context creation, route resolution, and Vue rendering. `onMetrics` receives request id, application id, those phase durations, total duration, HTML bytes, and hydration-state bytes. Apollo transport measurement can be added through the consumer's request-specific fetch/link without sharing state.

## Required controlled comparison

After Ring 3 permission is granted:

1. Use the same production Node version, machine/container limits, compiled commit, API deployment, network path, dataset, store/domain, and warmed/cold state for old and new runtimes.
2. Measure homepage, listing, product, not-found, unavailable-API, and invalid-domain requests.
3. Record p50/p95 TTFB, full render, domain lookup, GraphQL time/count, state/HTML/JS bytes, hydration time and hydration requests, LCP/CLS/INP, idle memory, memory after repeated requests, throughput at 1/10/50 concurrency, cold start, and error duration.
4. Run enough samples to report distribution rather than a single request. Keep raw command/config output with the result artifact.
5. Treat a result as improved only when the confidence interval and operational variance support it. Record regressions and unchanged metrics explicitly.

Initial targets, subject to baseline ratification: warm p50 TTFB at or below 200 ms, p95 at or below 600 ms, render p50 at or below 80 ms, no duplicate hydration request, no hydration warning, state below 200 KB, HTML below 150 KB, and no continuing memory growth under repeated isolated requests.
