# Annotate-Agent UX

This is a Core-level pointer page for the interaction model shared by the
prompt lab and docs lab. It is not a contract: the linked implementations are
authoritative.

## Interaction model

| Gesture or element | Behavior |
| --- | --- |
| Annotate mode | Every annotation is an agent request; edit affordances yield to targeting and review. |
| Hover | Resolve and ring the deepest eligible target. |
| Click | Pin the target and open the inline composer beside it. |
| Cmd/Ctrl+drag | Select a bounded range; show its live dotted ring and file one request against it. |
| Inline composer | Enter files with the request; choose a batch disposition for selected files or a global disposition for the request. |
| Request queue | Collect filed requests and use one **Apply** action to begin the session. |
| Staged inline diff | Review staged red/green changes in context, one request at a time. |
| Accept / Reject | Accept from the head or reject from the tail so a review decision preserves the staged sequence. |
| Waiting-on-human thread | Show amber thread bars for requests awaiting a human reply; replies continue that request. |
| Target fingerprint | Compare the filed target with its current fingerprint and show a “target changed since filed” chip when they differ. |
| Glass panel | Provide **Edit** and **AI** tabs: direct editing in one, annotation/request work in the other. |
| Outline sidebar | Keep the document outline visible and scroll-spy it to the active content. |

## Three layers

### Layer 1: shared targeting and annotate mode

`@codecaine-ai/annotations` is the shared implementation of annotate-mode
targeting. Its [“The standard annotate-mode UX” section](../annotations/README.md#the-standard-annotate-mode-ux)
is the spec of record for hover, pin, range selection, and the anchored
composer.

### Layers 2–3: parallel request and review sessions

The request queue/session and staged-diff review implementations are parallel:

- Prompt Kit: [lab UI](../prompt-kit/packages/prompt-kit/src/ui/lab/), operating over `PromptStep` values and row indexes.
- Docs System: [viewer lab](../docs-system/packages/docs-viewer/src/lab/) and [workbench lab](../docs-system/packages/docs-workbench/web/src/lab/), operating over `DocOp` values and block ids.

They intentionally are not shared. Docs System needs server-side content hashes,
draft locks, a staged-proposals sidecar, and SSE; Prompt Kit does not. Share the
interaction model, not the session machinery.

### Division of responsibility

Layer 1 owns only the interaction that turns a visible target into an agent
request:

- target discovery and eligibility;
- hover and pinned rings;
- Cmd/Ctrl+drag range targeting; and
- the anchored composer shell.

Each lab owns what happens after a request is filed:

- request lifecycle and queue state;
- target identity and staleness rules;
- proposal generation and staged-diff state; and
- accept/reject persistence and recovery.

This boundary keeps the common user vocabulary consistent while letting each
surface preserve the data model and runtime machinery it actually needs.

## Where things live

| Thing | Location | Notes |
| --- | --- | --- |
| Shared annotations package | [`annotations/`](../annotations/) | `@codecaine-ai/annotations`; Layer 1 targeting implementation. |
| Prompt Kit lab | [`prompt-kit/packages/prompt-kit/src/ui/lab/`](../prompt-kit/packages/prompt-kit/src/ui/lab/) | Queue, session, and staged review over `PromptStep`/row indexes. |
| Docs viewer lab | [`docs-system/packages/docs-viewer/src/lab/`](../docs-system/packages/docs-viewer/src/lab/) | Docs-facing Layer 2–3 UI. |
| Docs workbench lab | [`docs-system/packages/docs-workbench/web/src/lab/`](../docs-system/packages/docs-workbench/web/src/lab/) | Workbench controller and projection. |
| Prompt Kit agent kernel | [`prompt-kit/packages/prompt-kit-agent/`](../prompt-kit/packages/prompt-kit-agent/) | `@codecaine-ai/prompt-kit-agent`, port `:4850`. |
| Docs kernel | [`docs-system/packages/docs-kernel/`](../docs-system/packages/docs-kernel/) | `@codecaine-ai/docs-kernel`, port `:4840`. |
| Observatory registration | [`observatory/registry.example.json`](../observatory/registry.example.json) | Registers Prompt Kit and Docs System kernels for observation. |

## Reading order

1. Start with the [annotations UX standard](../annotations/README.md#the-standard-annotate-mode-ux) for Layer 1 behavior.
2. Read the [Prompt Kit interaction model](../prompt-kit/docs/20-implementation/20-editor/80-interaction-model.md) for prompt-surface details.
3. Read the Docs System labs for document-surface session and review details.
4. Use Observatory to inspect the registered kernels while they run.

## Authority

Use this page to find the shared model quickly. For behavior, data shape, or
implementation detail, follow the links above: the package and surface
implementations are authoritative.
