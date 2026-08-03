# Codecaine Core

Codecaine Core exists to build interaction surfaces for intelligence. This
directory is an umbrella checkout for six independent peer repositories. Five
primitives define agents, run them, and give humans and agents shared artifacts
to read and change; a development tool makes their work legible across the
suite. Each primitive is one deliberately designed surface for that
collaboration. The end state is Spectre, a full coding implementation agent
assembled from these primitives.

## Purpose

As agent capability grows, its interaction surfaces matter more. The UI and UX
determine how people inspect agent work, guide it, and change the same state.

- Each surface makes intelligence legible through a typed artifact.
- Humans and agents share one source of truth.
- Both can read and change that source through interfaces suited to their work.

The primitives and their documentation exist to clarify thinking about system
design.

- Explicit documents and operations produce systems their authors understand.
- Documentation records the model for both humans and agents.
- Readability is a feature.
  - Attention is scarce.
  - These docs are designed to be beautiful and pleasurable to read.

## Spectre

Spectre is both the origin and destination of this suite. The primitives were
extracted from its monorepo and are being rebuilt as clean peers that recombine
into a full coding implementation agent.

- Spectre's agents and structured prompts come from `prompt-kit`.
- Agent execution, tools, and orchestration come from `agent-kernel`.
- Its shared spatial board comes from `canvas`.
- Its shared structured documents come from `docs-system`.
- Its shared sequence diagrams come from `sequence`.

These are the surfaces where Spectre thinks and communicates. Canvas records the
provenance directly: its engine and design-reference corpus were extracted from
Spectre, while application-coupled integrations stayed there.

## Repository Model

This umbrella checkout is not a monorepo or an ownership hierarchy. Every
primitive is a peer. None lives inside another, and each repository keeps its
own packages, documentation, releases, and development workflow.

## System Linkage

[`prompt-kit`](https://github.com/Codecaine-AI/prompt-kit) defines agents'
prompts. It provides a canonical typed prompt AST, TypeScript builders,
renderers, transforms, validation, and preview and editor models. Prompts remain
structured long enough to compose, inspect, rewrite, and render predictably.

[`agent-kernel`](https://github.com/Codecaine-AI/agent-kernel) runs agents. It
owns runtime context, tool binding, spawning and subagent orchestration,
concurrency, durable traces, and trace viewers. Its packages consume the
`@codecaine-ai/prompt-kit` library as a Core workspace member. The Prompt Kit
library package does not depend on the kernel.

The other three peers are document surfaces:

- [`canvas`](https://github.com/Codecaine-AI/canvas)
  - A typed-action world-space board engine and standalone studio.
- [`docs-system`](https://github.com/Codecaine-AI/docs-system)
  - A normalized block-document system with safe mutation, viewing, editing,
    and a workbench.
- [`sequence`](https://github.com/Codecaine-AI/sequence)
  - A UML 2.x sequence-diagram engine and standalone studio with deterministic
    layout and rendering.

`observatory` is a development tool, not a primitive or document surface. It
registers kernel harnesses ("projects") and provides one unified UI for browsing
their agents, prompts, and traces across the suite. It reads each harness's
trace database read-only and proxies prompt and catalog operations to running
harnesses. No harness depends on it. Observatory is omitted from the diagram
because it observes the system rather than participating in it.

The kernel wires agents to these surfaces. Agent definitions and rendered
prompts come from `prompt-kit`. The kernel supplies execution, tools, spawning,
and observability. Surface adapters let agents inspect and mutate typed
documents. The surfaces do not become kernel internals, and the kernel does not
become part of a surface.

```text
                         +----------------+
                         |   prompt-kit   |
                         | defines agents |
                         +-------+--------+
                                 |
                                 v
                      +----------+-----------+
                      |     agent-kernel     |
                      | runs, wires, traces  |
                      +----+--------+--------+
                           /        |        \
                          v         v         v
                 +---------+  +-----------+  +----------+
                 | canvas  |  |docs-system|  | sequence |
                 | surface |  |  surface  |  | surface  |
                 +---------+  +-----------+  +----------+
```

## Shared Architecture

The three document surfaces share one architectural shape:

1. A typed JSON document is the source of truth.
2. An engine renders and mutates that document.
3. A studio UI gives humans a direct authoring surface.
4. An agent-facing projection exposes a compact, task-appropriate way to read
   and change the document.

Each projection fits its medium:

- `canvas`
  - Exposes board-oriented operations.
- `docs-system`
  - Projects normalized blocks to and from Markdown.
- `sequence`
  - Uses a compact text program that can be regenerated without treating layout
    or style as source data.

## Repositories

- [Codecaine-AI/prompt-kit](https://github.com/Codecaine-AI/prompt-kit)
- [Codecaine-AI/agent-kernel](https://github.com/Codecaine-AI/agent-kernel)
- [Codecaine-AI/canvas](https://github.com/Codecaine-AI/canvas)
- [Codecaine-AI/docs-system](https://github.com/Codecaine-AI/docs-system)
- [Codecaine-AI/sequence](https://github.com/Codecaine-AI/sequence)
- observatory (local peer)

Hosts clone or mount the peers they need and pin each independently. Each host
keeps its workflow and product policy.

## Development

This checkout is a bun meta-workspace across annotations, prompt-kit (itself a
nested workspace), canvas, sequence, agent-kernel, and docs-system: `bun install`
at this root wires every cross-repo dependency to live source, and
`bun run doctor` verifies the wiring.
[`DEVELOPMENT.md`](./DEVELOPMENT.md) covers the topology, setup, daily flow,
and the doctor's checks.

## Running Observatory

From this directory, `make observatory` installs and starts Observatory.

- UI: http://127.0.0.1:4891
- API: http://127.0.0.1:4890
