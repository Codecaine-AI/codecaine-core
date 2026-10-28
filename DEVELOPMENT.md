# Development

How to develop across the Codecaine peer repos from this umbrella checkout. Core is a private bun meta-workspace: one install at the root wires every cross-repo dependency to live source, and one doctor script guards the invariants that keep it that way. Read this before installing, adding an app, or debugging a dependency that behaves stale.

## Topology

- `Core/package.json` is a private workspace (`codecaine-core`) with 22 members via the globs `annotations`, `prompt-kit/packages/*`, `canvas/packages/*`, `sequence/packages/*`, `agent-kernel/packages/*`, `agent-kernel/examples/*`, `docs-system/packages/*`, `design-system`.
- Cross-repo dependencies are `workspace:*`. Every member resolves every other member as a symlink to live source through `Core/node_modules`.
- `Core/bunfig.toml` pins `[install] linker = "hoisted"`.
  - Bun 1.3 defaults to the isolated linker, which leaves the root without hoisted packages.
  - The repo-root scripts (canvas, sequence, docs-system, agent-kernel roots are not members) resolve dependencies by walking up to `Core/node_modules`, so hoisting is required.
- One React: the hoisted copy at `Core/node_modules/react` is the only real `react` directory in scope.
- Deliberate exceptions:
  - `agent-kernel/package.json` (repo root, not a member) keeps `"@codecaine-ai/prompt-kit": "link:@codecaine-ai/prompt-kit"` as a devDep.
  - `observatory/` is untouched and uses global links.
  - `docs-system/external/*`, `docs-system/reference/*`, `canvas/tools/docs-framework`, and `canvas/packages/eval-suite/runner` are excluded from the workspace globs and every doctor scan; they exist for standalone use and collide with member names by design.

## Fresh machine

Clone Core, then let the bootstrap script clone every member repo and install the root workspace. Run the doctor afterward to verify the workspace invariants.

```sh
git clone https://github.com/Codecaine-AI/codecaine-core.git
cd codecaine-core
bun run bootstrap
bun run doctor
```

## Daily Flow

- Edit source anywhere; every consumer resolves it live through the workspace symlinks.
- HMR picks up source edits in running vite apps. Restart a vite app only after config changes (`vite.config.*`, env, deps).
- After changing any `package.json`: `bun install` at Core root, then `bun run doctor`.
- When a dependency behaves stale: `bun run doctor` first, code second.

## Releases

Fifteen workspace members publish to public npm under `@codecaine-ai`. A member is public when its `package.json` has no `"private": true`. Apps outside Core install them like any npm package, and Core keeps `workspace:*` so one change can still span several packages.

Each member repo has one version, shared by every package in it. To release:

1. Bump the repo: `bun run release bump <repo> <patch|minor|major>`. Commit the version lines in that repo and merge them.
2. Check: `bun run release --check`. It lists what will publish and flags published packages whose ranges no longer accept a local version. Bump those repos too.
3. Dry run: `bun run release --dry-run`.
4. Publish: `bun run release`. npm needs 2FA for writes, so run it in a terminal, or point `NPM_CONFIG_USERCONFIG` at a temporary npmrc that holds a granular token with bypass-2FA.
5. Wait: npm shows a `0.0.0-stage` placeholder for a few minutes before the new version appears.

The script (`scripts/release.ts`) publishes in dependency order and skips versions already on npm, so a failed run can be repeated. It also:

- Rewrites `workspace:*` to `^<version>` in the published copy only, and restores each manifest after its publish.
- Refuses a public package that depends on a private one, a `files` list that drops an entry point, and an invalid version. A prerelease publishes to the `next` tag.
- Copies the repo `LICENSE` and `README.md` into a package that has none.
- Uses `npm publish`, not `bun publish`, because bun resolves `workspace:*` from the member repo's stale standalone `bun.lock`.

Two rules keep a published package working outside Core:

- Packages ship TypeScript source. Consumers need Bun or a TypeScript-aware bundler, and an app's `tsc` type-checks that source.
- A package that renders React lists `react` and `react-dom` in `peerDependencies`, never `dependencies`. A pinned React gives the app a second copy.

## Containers

Containers mount the working tree instead of baking it into an image. The image pins bun 1.3.10 and OS dependencies only, then runs `bun install` against the mounted Core root at container start.

Run one service:

```sh
docker compose up docs-kernel
```

Run every service, or stop the runtime:

```sh
docker compose up
make docker-up
make docker-down
```

The `bun-cache` named volume keeps repeated installs fast. Overlay `node_modules` volumes keep Linux-native installs out of the host checkout while all source stays mounted live.

| Service | Ports |
|---|---|
| observatory | 4890 API, 4891 UI |
| prompt-kit-kernel | 4850 |
| core-harness | 4860 |
| docs-kernel | 4840 |
| docs-web | 4803 |

The images run live source for development. A deployed service can install the published `@codecaine-ai` versions instead; see Releases.

## Adding a New App

For any new vite app inside a member repo:

1. Add its package under an existing workspace glob (or extend the globs in `Core/package.json`).
2. In `vite.config.*`, add every workspace source dep to `optimizeDeps.exclude` — a prebundled source dep is served from a stale cache and never hot-reloads.
3. Add `server.fs.allow` entries covering the Core root (or each sibling repo the app imports from) so vite serves source outside the app's own repo.
4. Add `resolve.dedupe: ["react", "react-dom"]` — two Reacts crash hooks.
5. Run `bun install` at Core root, then `bun run doctor`.

Non-vite apps need only steps 1 and 5.

## Standalone-Repo Caveats

Each repo remains a standalone git repo with its own lockfile and workflow, but standalone behavior differs from Core behavior:

- `workspace:*` deps do not resolve outside Core. A standalone `bun install` inside agent-kernel or canvas cannot wire cross-repo deps; that is accepted.
- Repo Makefile targets that used to `bun install` locally (`canvas` studio/harness/traces, `docs-system`, `sequence`) now run `cd .. && bun install` so `make traces` and friends install at Core root. Any new Makefile target follows the same pattern.
- Per-repo `bun.lock` files serve standalone checkouts only. They drift from `Core/bun.lock`, which is canonical here; the doctor reports drift as info, not failure.
- `docs-system/external/*` and `canvas/tools/docs-framework` are git submodules carrying their own copies of member-named packages for standalone use. They stay out of the workspace globs.
- Never run `bun install` inside a member while working from Core: it plants real dependency copies that shadow the live symlinks. The doctor flags them.

## The Doctor

`bun run doctor` verifies the workspace; `bun run doctor:fix` also deletes what is safe to delete. Any ✗ exits non-zero; every finding prints a FIX command.

| # | Check | Guards against |
|---|-------|----------------|
| 1 | Install freshness | A manifest edited after the last root install (✗) |
| 2 | Workspace symlinks | A member missing or dangling in `Core/node_modules` (✗) |
| 3 | Single React | A nested real `react` copy — two Reacts crash hooks (✗) |
| 4 | Vite prebundle audit | A workspace dep of a vite app that resolves to a real copy without an `optimizeDeps.exclude` entry — the stale-bundle incident (✗, prints the exact line to add) |
| 5 | Stale `.vite` caches | Prebundle caches that survive restarts and never hot-reload (⚠, `--fix` deletes) |
| 6 | Shadowing node_modules | Real copies of member packages nested under a member, shadowing live source (⚠, `--fix` removes). Bun's hoisted version-conflict splits (nested `vite`, `tailwindcss`, …) are normal and pass. |
| 7 | Rogue dep protocols | `link:` or Codecaine git-pinned cross-repo deps outside the sanctioned exceptions (✗, convert to `workspace:*`) |
| 8 | Lockfile drift | Per-repo lockfiles newer than `Core/bun.lock` (ℹ only) |
| 9 | Design-system lint | A Core app in `design-system/apps.json` that fails `bun run lint:apps` (⚠ only, prints the failing checks and the command that lists every violation; one ⚠ when the design-system or `lint:apps` is missing) |

## Why This Exists

One debugging session produced this workspace. A "fixed" bug kept reproducing for hours because the running app was not executing the edited source. Three mechanisms stacked:

- `@codecaine-ai/annotations` was missing from one vite `optimizeDeps.exclude` list. Vite prebundled it into `node_modules/.vite` — a cache that survives restarts and never hot-reloads — so every edit landed in source while the app served the stale bundle.
- agent-kernel had prompt-kit git-pinned in some manifests and `link:`-ed in others: one app, two prompt-kit versions.
- Global `bun link` required per-machine registration, so machines silently diverged.

The meta-workspace eliminates the second and third mechanisms (`workspace:*` everywhere, no global links). The doctor guards all three.
