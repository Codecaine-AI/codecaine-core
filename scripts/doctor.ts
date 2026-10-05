#!/usr/bin/env bun
/**
 * Core workspace doctor.
 *
 * Verifies the health of the Codecaine Core bun meta-workspace: install
 * freshness, workspace symlinks, single hoisted React, vite prebundle
 * hazards, stale .vite caches, shadowing node_modules, rogue dependency
 * protocols, per-repo lockfile drift, and the design-system lint of Core's
 * apps.
 *
 * Usage:
 *   bun scripts/doctor.ts          # report only
 *   bun scripts/doctor.ts --fix    # also delete .vite caches and shadowing copies
 *
 * Exit code: non-zero when any check fails (✗). Warnings (⚠) and info (ℹ)
 * do not fail the run.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const CORE = resolve(import.meta.dir, "..");
const FIX = process.argv.includes("--fix");

/** Directories excluded from every scan (relative to Core). These exist for
 * standalone use and deliberately carry their own dependency trees:
 * - observatory: global-link based, untouched by the meta-workspace
 * - docs-system/external: git submodules of canvas/sequence for standalone docs
 * - docs-system/reference: vendored third-party corpora (blocksuite, AFFiNE)
 * - canvas/tools: docs-framework submodule for standalone use
 * - canvas/packages/eval-suite/runner: isolated eval runner with its own deps
 */
const IGNORES = [
  "observatory",
  "docs-system/external",
  "docs-system/reference",
  "canvas/tools",
  "canvas/packages/eval-suite/runner",
];

const REPOS = ["annotations", "prompt-kit", "canvas", "sequence", "agent-kernel", "docs-system"];

/** Deliberate exceptions to the workspace:* rule. agent-kernel's repo root is
 * not a workspace member, so its devDep on prompt-kit stays a link:. */
const PROTOCOL_EXCEPTIONS = [
  { manifest: "agent-kernel/package.json", dep: "@codecaine-ai/prompt-kit", prefix: "link:" },
];

// ---------------------------------------------------------------------------
// Helpers

function isIgnored(rel: string): boolean {
  return IGNORES.some((p) => rel === p || rel.startsWith(p + "/"));
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function mtime(path: string): number {
  return statSync(path).mtimeMs;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

interface Member {
  dir: string; // relative to CORE
  name: string;
  manifest: any;
}

/** Expand the workspaces globs from Core/package.json into member packages. */
function listMembers(): Member[] {
  const globs: string[] = readJson(join(CORE, "package.json")).workspaces;
  const members: Member[] = [];
  for (const glob of globs) {
    const dirs: string[] = [];
    if (glob.endsWith("/*")) {
      const parent = glob.slice(0, -2);
      const abs = join(CORE, parent);
      if (existsSync(abs)) {
        for (const e of readdirSync(abs, { withFileTypes: true })) {
          if (e.isDirectory() && existsSync(join(abs, e.name, "package.json"))) {
            dirs.push(join(parent, e.name));
          }
        }
      }
    } else if (existsSync(join(CORE, glob, "package.json"))) {
      dirs.push(glob);
    }
    for (const dir of dirs) {
      const manifest = readJson(join(CORE, dir, "package.json"));
      members.push({ dir, name: manifest.name, manifest });
    }
  }
  return members;
}

const members = listMembers();
const memberNames = new Set(members.map((m) => m.name));
const memberByName = new Map(members.map((m) => [m.name, m]));

// ---------------------------------------------------------------------------
// Tree walk: collect vite configs, node_modules contents, hazards.

const viteConfigs: string[] = []; // rel paths
const viteCaches: string[] = []; // rel paths of node_modules/.vite dirs
const reactCopies: string[] = []; // rel paths of real react/react-dom dirs beyond root
const shadowCopies: string[] = []; // rel paths of real copies of workspace member packages
let rootReactFound = false;

function scanPackageEntry(name: string, pkgAbs: string, pkgRel: string, nmRel: string, depth: number) {
  if (isSymlink(pkgAbs)) return; // symlinks into workspace source are the healthy state
  if (!existsSync(join(pkgAbs, "package.json"))) return;
  if (name === "react" || name === "react-dom") {
    if (nmRel === "node_modules") {
      if (name === "react") rootReactFound = true;
    } else {
      reactCopies.push(pkgRel);
    }
  }
  if (memberNames.has(name)) shadowCopies.push(pkgRel);
  // Recurse into this package's own node_modules (hoisted conflict nesting).
  const nested = join(pkgAbs, "node_modules");
  if (depth < 4 && existsSync(nested)) scanNodeModules(nested, pkgRel + "/node_modules", depth + 1);
}

function scanNodeModules(nmAbs: string, nmRel: string, depth: number) {
  let entries;
  try {
    entries = readdirSync(nmAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === ".vite") {
      viteCaches.push(nmRel + "/.vite");
      continue;
    }
    if (e.name.startsWith(".")) continue; // .bin, .cache, .vite-temp — installer artifacts
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith("@")) {
      const scopeAbs = join(nmAbs, e.name);
      let subs;
      try {
        subs = readdirSync(scopeAbs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of subs) {
        if (!s.isDirectory() && !s.isSymbolicLink()) continue;
        const full = `${e.name}/${s.name}`;
        scanPackageEntry(full, join(scopeAbs, s.name), `${nmRel}/${full}`, nmRel, depth);
      }
    } else {
      scanPackageEntry(e.name, join(nmAbs, e.name), `${nmRel}/${e.name}`, nmRel, depth);
    }
  }
}

function walk(dirAbs: string, rel: string) {
  let entries;
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (isIgnored(r) || e.name === ".git" || e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (e.name === "node_modules") scanNodeModules(join(dirAbs, e.name), r, 0);
      else walk(join(dirAbs, e.name), r);
    } else if (/^vite\.config\.(ts|mts|js|mjs|cjs|cts)$/.test(e.name)) {
      viteConfigs.push(r);
    }
  }
}

// Scan the member repos plus the hoisted root node_modules.
for (const repo of REPOS) walk(join(CORE, repo), repo);
scanNodeModules(join(CORE, "node_modules"), "node_modules", 0);

// ---------------------------------------------------------------------------
// Reporting

let failed = false;

function report(status: "ok" | "fail" | "warn" | "info", title: string, lines: string[] = []) {
  const symbol = { ok: "✓", fail: "✗", warn: "⚠", info: "ℹ" }[status];
  if (status === "fail") failed = true;
  console.log(`${symbol} ${title}`);
  for (const line of lines) console.log(`    ${line}`);
}

console.log(`Core workspace doctor — ${CORE}`);
console.log(`${members.length} workspace members${FIX ? " (--fix)" : ""}\n`);

// ---------------------------------------------------------------------------
// Member repos

{
  const manifest = join(CORE, "members.json");
  if (!existsSync(manifest)) {
    report("fail", "Member repos: members.json missing", ["FIX: bun run bootstrap"]);
  } else {
    const repos: { dir: string }[] = readJson(manifest);
    const missing = repos.filter((repo) => !existsSync(join(CORE, repo.dir, ".git")));
    if (missing.length) {
      report("fail", "Member repos: repositories missing", [
        ...missing.map((repo) => `missing: ${repo.dir}`),
        "FIX: bun run bootstrap",
      ]);
    } else {
      report("ok", `Member repos: ${repos.length} present`);
    }
  }
}

// ---------------------------------------------------------------------------
// Design system
//
// @codecaine-ai/design-system (tokens and layout CSS for every app) sits beside
// the workspace: package.json workspaces lists ../../design-system. It has no
// git remote yet, so bootstrap cannot clone it, and without the folder
// `bun install` stops with "Workspace not found". Its dist/ is committed and
// must match its tokens/: `scripts/build.ts --check` exits 1 when it is stale.

{
  const dir = resolve(CORE, "../../design-system");
  if (!existsSync(join(dir, "package.json"))) {
    report("fail", "Design system: ../../design-system/package.json missing", [
      `expected: ${dir}`,
      "FIX: copy or clone the design-system folder to that path (no git remote yet, so bootstrap cannot clone it), then bun install",
    ]);
  } else {
    const run = Bun.spawnSync(["bun", join(dir, "scripts", "build.ts"), "--check"], { cwd: dir });
    if (run.exitCode !== 0) {
      const details = `${run.stdout}${run.stderr}`
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean);
      report("fail", "Design system: build outputs are stale or tokens are invalid", [
        ...details,
        `FIX: (cd "${dir}" && bun run build && bun run test)`,
      ]);
    } else {
      report("ok", "Design system: ../../design-system present, dist/ matches tokens/");
    }
  }
}

// ---------------------------------------------------------------------------
// Observatory registry
//
// The observatory discovers kernels via its machine-local registry.json.
// Warn (never fail — the registry is per-machine and hand-curated) when a
// member repo carries a kernel manifest that the registry does not know
// about, or when a registry entry drifts from its manifest. The discovery
// and comparison logic lives in the observatory's own sync script; this
// check just shells out to it.

{
  const script = join(CORE, "observatory", "scripts", "sync-registry.ts");
  const registryFile = join(CORE, "observatory", "registry.json");
  if (existsSync(script)) {
    if (!existsSync(registryFile)) {
      report("info", "Observatory registry: no machine-local registry.json yet", [
        "FIX: cp observatory/registry.example.json observatory/registry.json",
      ]);
    } else {
      const run = Bun.spawnSync(["bun", script, "--check"], { cwd: join(CORE, "observatory") });
      if (run.exitCode !== 0) {
        const details = `${run.stdout}${run.stderr}`
          .split("\n")
          .filter(
            (line) =>
              line.startsWith("✗") || line.startsWith("⚠") || line.startsWith("    "),
          )
          .map((line) => line.trimEnd());
        report("warn", "Observatory registry: member kernels unregistered or drifted", [
          ...details,
          "FIX: (cd observatory && bun run registry:sync)  # adds missing; never overwrites",
        ]);
      } else {
        report("ok", "Observatory registry: member kernels registered, no drift");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Install freshness

{
  const lock = join(CORE, "bun.lock");
  const nm = join(CORE, "node_modules");
  if (!existsSync(nm) || !existsSync(lock)) {
    report("fail", "Install freshness: Core/node_modules or Core/bun.lock missing", [
      `FIX: (cd "${CORE}" && bun install)`,
    ]);
  } else {
    // Last-install time: bun touches node_modules/.bin on every install run,
    // including no-op runs that leave bun.lock's mtime alone (e.g. after a
    // scripts-only manifest edit). Use the newer of the two.
    const bin = join(nm, ".bin");
    const installM = Math.max(mtime(lock), existsSync(bin) ? mtime(bin) : 0);
    const stale: string[] = [];
    if (mtime(join(CORE, "package.json")) > installM) stale.push("package.json");
    for (const m of members) {
      if (mtime(join(CORE, m.dir, "package.json")) > installM) stale.push(`${m.dir}/package.json`);
    }
    if (stale.length) {
      report("fail", "Install freshness: manifests changed after the last install", [
        ...stale.map((s) => `newer than the last install: ${s}`),
        `FIX: (cd "${CORE}" && bun install)`,
      ]);
    } else {
      report("ok", "Install freshness: last install is newer than every manifest");
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Workspace symlinks

{
  const missing: string[] = [];
  for (const m of members) {
    const link = join(CORE, "node_modules", m.name);
    if (!isSymlink(link)) {
      missing.push(m.name);
      continue;
    }
    try {
      const target = statSync(link); // follows the link; throws when dangling
      const real = Bun.resolveSync(join(link, "package.json"), CORE);
      if (resolve(dirname(real)) !== resolve(CORE, m.dir)) missing.push(`${m.name} (points elsewhere)`);
      void target;
    } catch {
      missing.push(`${m.name} (dangling)`);
    }
  }
  if (missing.length) {
    report("fail", "Workspace symlinks: members missing from Core/node_modules", [
      ...missing.map((n) => `missing: ${n}`),
      `FIX: (cd "${CORE}" && bun install)`,
    ]);
  } else {
    report("ok", `Workspace symlinks: all ${members.length} members symlinked in Core/node_modules`);
  }
}

// A standalone install can leave member-local symlinks pointing at vendored
// copies. Those shadow the healthy root links, so check from each consumer too.
{
  const wrong: string[] = [];
  let checked = 0;
  const consumers = [
    ...members,
    ...[...REPOS, "observatory"].flatMap((dir) => {
      const file = join(CORE, dir, "package.json");
      return existsSync(file) ? [{ dir, name: dir, manifest: readJson(file) }] : [];
    }),
  ];
  for (const consumer of consumers) {
    const deps = new Set(
      ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
        .flatMap((section) => Object.keys(consumer.manifest[section] ?? {})),
    );
    for (const dep of deps) {
      const member = memberByName.get(dep);
      if (!member) continue;
      checked++;
      let dir = join(CORE, consumer.dir);
      let actual: string | undefined;
      while (true) {
        const candidate = join(dir, "node_modules", dep);
        if (existsSync(candidate) || isSymlink(candidate)) {
          try { actual = realpathSync(candidate); } catch { /* dangling */ }
          break;
        }
        if (dir === CORE || dirname(dir) === dir) break;
        dir = dirname(dir);
      }
      const expected = realpathSync(join(CORE, member.dir));
      if (actual !== expected) {
        wrong.push(`${consumer.dir}: ${dep} resolves to ${actual ?? "missing/dangling"}; expected ${expected}`);
      }
    }
  }
  report(wrong.length ? "fail" : "ok", `Consumer workspace resolution: ${checked} local dependency edges checked`, wrong);
}

{
  const link = join(CORE, "observatory", "node_modules", "@codecaine-ai", "prompt-kit");
  if (isSymlink(link)) {
    try {
      const real = realpathSync(link);
      const expectedSuffix = join("prompt-kit", "packages", "prompt-kit");
      if (!real.endsWith(expectedSuffix)) {
        report("fail", "Observatory prompt-kit symlink: points to the wrong package", [
          `resolves to: ${real}`,
          `expected path suffix: ${expectedSuffix}`,
        ]);
      } else {
        report("ok", "Observatory prompt-kit symlink: points to prompt-kit/packages/prompt-kit");
      }
    } catch {
      report("fail", "Observatory prompt-kit symlink: dangling or unreadable", [`link: ${link}`]);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Single React

{
  if (!rootReactFound) {
    report("fail", "Single React: no hoisted react at Core/node_modules/react", [
      `FIX: (cd "${CORE}" && bun install)`,
    ]);
  } else if (reactCopies.length) {
    report("fail", "Single React: nested react copies found (two Reacts crash hooks)", [
      ...reactCopies.map((p) => `extra copy: ${p}`),
      ...reactCopies.map((p) => `FIX: rm -rf "${join(CORE, p)}"`),
      `then: (cd "${CORE}" && bun install)`,
    ]);
  } else {
    report("ok", "Single React: exactly one react (hoisted at Core/node_modules/react)");
  }
}

// ---------------------------------------------------------------------------
// 4. Vite prebundle audit
//
// Vite does not prebundle a workspace dep as long as it resolves through the
// root symlink to source outside node_modules. The incident mechanism is a
// REAL copy inside some node_modules (git-pin, standalone install): vite
// prebundles that copy into node_modules/.vite, a cache that survives
// restarts and never hot-reloads. So: for every vite app, every workspace
// dep in its transitive closure must either resolve as a symlink to live
// source (no real copy anywhere in scope) or be listed in
// optimizeDeps.exclude.

{
  // Transitive workspace-dep closure per member name.
  function workspaceDeps(manifest: any): string[] {
    const out: string[] = [];
    for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const dep of Object.keys(manifest[section] ?? {})) {
        if (memberNames.has(dep)) out.push(dep);
      }
    }
    return out;
  }
  function closure(seed: string[]): Set<string> {
    const seen = new Set<string>(seed);
    const queue = [...seed];
    while (queue.length) {
      const m = memberByName.get(queue.pop()!);
      if (!m) continue;
      for (const dep of workspaceDeps(m.manifest)) {
        if (!seen.has(dep)) {
          seen.add(dep);
          queue.push(dep);
        }
      }
    }
    return seen;
  }
  const realCopyByName = new Map<string, string[]>();
  for (const p of shadowCopies) {
    const name = p.split("/node_modules/").pop()!;
    realCopyByName.set(name, [...(realCopyByName.get(name) ?? []), p]);
  }

  const problems: string[] = [];
  for (const cfg of viteConfigs) {
    // Nearest ancestor package.json is the app manifest.
    let appDir = dirname(join(CORE, cfg));
    while (appDir !== CORE && !existsSync(join(appDir, "package.json"))) appDir = dirname(appDir);
    if (appDir === CORE) continue;
    const appManifest = readJson(join(appDir, "package.json"));
    const deps = closure(workspaceDeps(appManifest));
    if (!deps.size) continue;
    // Text scan: quoted package names anywhere in the config count as excluded.
    const text = readFileSync(join(CORE, cfg), "utf8");
    const quoted = new Set([...text.matchAll(/["'`](@[^"'`]+)["'`]/g)].map((m) => m[1]));
    const missing = [...deps].filter((d) => realCopyByName.has(d) && !quoted.has(d));
    if (missing.length) {
      problems.push(`${cfg}: workspace deps resolve to real copies but are not excluded`);
      for (const d of missing) {
        for (const copy of realCopyByName.get(d)!) problems.push(`  real copy: ${copy}`);
      }
      problems.push(`  FIX: add to optimizeDeps.exclude in ${cfg}:`);
      problems.push(`    optimizeDeps: { exclude: [${missing.map((d) => `"${d}"`).join(", ")}] },`);
      problems.push(`  (or delete the real copy and rerun bun install at Core root)`);
    }
  }
  if (problems.length) {
    report("fail", "Vite prebundle audit: stale-bundle hazard detected", problems);
  } else {
    report(
      "ok",
      `Vite prebundle audit: ${viteConfigs.length} configs; every workspace dep resolves to live source or is excluded`,
    );
  }
}

// ---------------------------------------------------------------------------
// 5. Stale .vite caches

{
  if (viteCaches.length) {
    if (FIX) {
      for (const p of viteCaches) rmSync(join(CORE, p), { recursive: true, force: true });
      report("ok", `Stale .vite caches: deleted ${viteCaches.length} (--fix)`, viteCaches.map((p) => `removed: ${p}`));
    } else {
      report("warn", "Stale .vite caches: prebundle caches survive restarts and never hot-reload", [
        ...viteCaches.map((p) => `cache: ${p}`),
        ...viteCaches.map((p) => `FIX: rm -rf "${join(CORE, p)}"`),
        `or: bun run doctor:fix`,
      ]);
    }
  } else {
    report("ok", "Stale .vite caches: none");
  }
}

// ---------------------------------------------------------------------------
// 6. Shadowing node_modules
//
// bun's hoisted linker legitimately nests version-conflict copies (vite,
// tailwindcss, electron, …) inside member node_modules — those are fine and
// a fresh install produces them. What must never appear nested is a REAL
// copy of a workspace member package: it shadows the root symlink, so the
// app resolves a frozen copy instead of live source.

{
  if (shadowCopies.length) {
    if (FIX) {
      for (const p of shadowCopies) rmSync(join(CORE, p), { recursive: true, force: true });
      report("ok", `Shadowing node_modules: removed ${shadowCopies.length} copies (--fix)`, [
        ...shadowCopies.map((p) => `removed: ${p}`),
        `then: (cd "${CORE}" && bun install)`,
      ]);
    } else {
      report("warn", "Shadowing node_modules: real copies of workspace packages shadow live source", [
        ...shadowCopies.map((p) => `shadowing copy: ${p}`),
        ...shadowCopies.map((p) => `FIX: rm -rf "${join(CORE, p)}"`),
        `or: bun run doctor:fix   (then bun install at Core root)`,
      ]);
    }
  } else {
    report("ok", "Shadowing node_modules: no nested copies of workspace packages (conflict splits are fine)");
  }
}

// ---------------------------------------------------------------------------
// 7. Rogue dep protocols

{
  const rogue: string[] = [];
  const manifests = [
    ...members.map((m) => `${m.dir}/package.json`),
    ...REPOS.map((r) => `${r}/package.json`),
  ];
  for (const rel of new Set(manifests)) {
    const abs = join(CORE, rel);
    if (!existsSync(abs)) continue;
    const manifest = readJson(abs);
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [dep, spec] of Object.entries(manifest[section] ?? {}) as [string, string][]) {
        const isLink = spec.startsWith("link:");
        const isGitPin = /git\+.*codecaine/i.test(spec) || (/^(github:)?Codecaine-AI\//i.test(spec));
        if (!isLink && !isGitPin) continue;
        const excepted = PROTOCOL_EXCEPTIONS.some(
          (x) => x.manifest === rel && x.dep === dep && spec.startsWith(x.prefix),
        );
        if (!excepted) rogue.push(`${rel}: "${dep}": "${spec}"`);
      }
    }
  }
  if (rogue.length) {
    report("fail", "Rogue dep protocols: link:/git-pinned cross-repo deps found", [
      ...rogue,
      `FIX: convert to "workspace:*" and rerun bun install at Core root`,
    ]);
  } else {
    report("ok", "Rogue dep protocols: all cross-repo deps are workspace:* (sanctioned exceptions only)");
  }
}

// ---------------------------------------------------------------------------
// 8. Lockfile drift (info-only)

{
  const coreLockM = existsSync(join(CORE, "bun.lock")) ? mtime(join(CORE, "bun.lock")) : 0;
  const drifted: string[] = [];
  for (const repo of REPOS) {
    const lock = join(CORE, repo, "bun.lock");
    if (existsSync(lock) && mtime(lock) > coreLockM) drifted.push(`${repo}/bun.lock`);
  }
  if (drifted.length) {
    report("info", "Lockfile drift: per-repo lockfiles newer than Core/bun.lock", [
      ...drifted,
      "Per-repo lockfiles serve standalone checkouts only; Core/bun.lock is canonical here.",
    ]);
  } else {
    report("ok", "Lockfile drift: no per-repo lockfile is newer than Core/bun.lock");
  }
}

// ---------------------------------------------------------------------------
// 9. Design-system lint (warn-only)
//
// The design-system's apps.json registers every app that uses its tokens, and
// `bun run lint:apps` proves each one is wired and conformant. Run it for the
// registry apps inside Core (repo under codecaine/core/, minus IGNORES). Warn,
// never fail: the apps move onto the design system one pass at a time.

{
  const dir = resolve(CORE, "../../design-system");
  const workspace = resolve(CORE, "../..");
  const prefix = "codecaine/core/";
  const command = (ids: string[]) => `(cd "${dir}" && bun run lint:apps --root "${workspace}" ${ids.join(" ")})`;
  let apps: { id: string; repo: string; root?: string }[] | undefined;
  let problem = "../../design-system/package.json missing or unreadable";
  try {
    if (readJson(join(dir, "package.json")).scripts?.["lint:apps"]) {
      problem = "../../design-system/apps.json missing or unreadable";
      apps = readJson(join(dir, "apps.json")).apps;
    } else {
      problem = "../../design-system has no lint:apps script";
    }
  } catch {
    // missing or unreadable: reported below
  }
  if (!Array.isArray(apps)) {
    report("warn", `Design-system lint: ${problem}; apps not checked`, [`design-system: ${dir}`]);
  } else {
    const core = apps.filter((app) => app.repo.startsWith(prefix));
    const skipped = core.filter((app) => isIgnored((app.root ?? app.repo).slice(prefix.length)));
    const ids = core.filter((app) => !skipped.includes(app)).map((app) => app.id);
    if (skipped.length) {
      report("info", `Design-system lint: skipped ${skipped.map((app) => app.id).join(", ")} (IGNORES)`);
    }
    if (!ids.length) {
      report("info", `Design-system lint: no registry app under ${prefix}`);
    } else {
      const run = Bun.spawnSync(["bun", "run", "lint:apps", "--json", "--root", workspace, ...ids], { cwd: dir });
      let result: { apps: { id: string; ok: boolean; checks: { id: string; status: string; violations: unknown[] }[] }[] } | undefined;
      try {
        const parsed = run.exitCode === 0 || run.exitCode === 1 ? JSON.parse(run.stdout.toString()) : undefined;
        if (Array.isArray(parsed?.apps)) result = parsed;
      } catch {
        // no report: reported below
      }
      if (!result) {
        const details = `${run.stderr}`
          .split("\n")
          .map((line) => line.trimEnd())
          .filter((line) => line && !line.startsWith("$ "));
        report("warn", `Design-system lint: lint:apps exited ${run.exitCode} without a report; apps not checked`, [
          ...details,
          `run: ${command(ids)}`,
        ]);
      } else {
        for (const app of result.apps) {
          if (app.ok) {
            report("ok", `Design-system lint: ${app.id} passes`);
            continue;
          }
          const failing = (app.checks ?? [])
            .filter((check) => check.status === "fail")
            .map((check) => `${check.id} (${check.violations?.length ?? 0})`);
          report("warn", `Design-system lint: ${app.id} fails ${failing.join(", ")}`, [
            `every violation: ${command([app.id])}`,
          ]);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------

console.log("");
if (failed) {
  console.log("✗ doctor found problems — fix commands above.");
  process.exit(1);
}
console.log("✓ workspace healthy.");
