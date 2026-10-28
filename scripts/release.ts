#!/usr/bin/env bun
/**
 * Core release: publishes Core's public workspace members to npm.
 *
 * A member is public when its package.json has no `"private": true`. Each
 * member repo has one version, shared by every package in it. Publishing
 * sends every public package whose version is not on npm yet, in dependency
 * order, so a change that spans several repos ships in one run.
 *
 * Usage:
 *   bun scripts/release.ts                         # publish unpublished versions
 *   bun scripts/release.ts --dry-run               # npm publish --dry-run instead
 *   bun scripts/release.ts --check                 # show what would publish, and stale dependents
 *   bun scripts/release.ts bump <repo> <level|x.y.z>  # set a repo's version (level: patch, minor, major)
 *
 * Publishing needs `npm login` with publish rights on the @codecaine-ai org.
 * With 2FA on writes, run it in a terminal so npm can prompt for each package.
 *
 * Why not `bun publish`: bun resolves `workspace:*` from the nearest
 * bun.lock, which is the member repo's standalone lockfile, not Core's. That
 * lockfile holds stale versions, so the script rewrites `workspace:*` to
 * `^<current version>` itself and restores each manifest after its publish.
 */

import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Glob, semver } from "bun";

const CORE = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const CHECK = args.includes("--check");
const DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"] as const;
const RUNTIME_FIELDS = DEP_FIELDS.filter((f) => f !== "devDependencies");

type Member = { name: string; repo: string; dir: string; manifest: any; raw: string };

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function writeJson(path: string, value: any, raw: string) {
  const indent = raw.match(/^\{\n([ \t]+)/)?.[1] ?? "  ";
  writeFileSync(path, JSON.stringify(value, null, indent) + "\n");
}

function workspaceMembers(): Member[] {
  const root = JSON.parse(readFileSync(join(CORE, "package.json"), "utf8"));
  const members: Member[] = [];
  for (const pattern of root.workspaces as string[]) {
    for (const file of new Glob(`${pattern}/package.json`).scanSync({ cwd: CORE, onlyFiles: true })) {
      const rel = file.slice(0, -"/package.json".length);
      const dir = join(CORE, rel);
      const raw = readFileSync(join(dir, "package.json"), "utf8");
      const manifest = JSON.parse(raw);
      members.push({ name: manifest.name, repo: rel.split("/")[0], dir, manifest, raw });
    }
  }
  return members;
}

function internalDeps(m: Member, names: Set<string>): string[] {
  const deps = new Set<string>();
  for (const field of RUNTIME_FIELDS) {
    for (const dep of Object.keys(m.manifest[field] ?? {})) if (names.has(dep)) deps.add(dep);
  }
  return [...deps];
}

/** Orders members so each one comes after the members it depends on. */
function dependencyOrder(members: Member[], allNames: Set<string>): Member[] {
  const byName = new Map(members.map((m) => [m.name, m]));
  const ordered: Member[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (m: Member, path: string[]) => {
    if (state.get(m.name) === "done") return;
    if (state.get(m.name) === "visiting") fail(`dependency cycle: ${[...path, m.name].join(" → ")}`);
    state.set(m.name, "visiting");
    for (const dep of internalDeps(m, allNames)) {
      const target = byName.get(dep);
      if (!target) fail(`${m.name} is public but depends on private ${dep}. Publish ${dep} too, or drop the dependency.`);
      visit(target, [...path, m.name]);
    }
    state.set(m.name, "done");
    ordered.push(m);
  };
  for (const m of [...members].sort((a, b) => a.name.localeCompare(b.name))) visit(m, []);
  return ordered;
}

/** Replaces every workspace: specifier with a caret range on the dependency's current version. */
function publishManifest(m: Member, versions: Map<string, string>): any {
  const manifest = structuredClone(m.manifest);
  for (const field of DEP_FIELDS) {
    const deps = manifest[field];
    if (!deps) continue;
    for (const [dep, spec] of Object.entries(deps)) {
      if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
      if (field === "devDependencies") delete deps[dep];
      else if (versions.has(dep)) deps[dep] = `^${versions.get(dep)}`;
      else fail(`${m.name} has ${field}.${dep}: ${spec}, and ${dep} is not public`);
    }
  }
  if (JSON.stringify(manifest).includes('"workspace:')) fail(`${m.name} still has a workspace: specifier`);
  return manifest;
}

async function npmView(spec: string, field: string): Promise<any> {
  const proc = Bun.spawn(["npm", "view", spec, field, "--json"], { stdout: "pipe", stderr: "ignore" });
  const text = (await new Response(proc.stdout).text()).trim();
  return text ? JSON.parse(text) : undefined;
}

/** Published packages whose dependency ranges no longer accept a local version. Each one needs a bump. */
async function staleDependents(publicMembers: Member[], versions: Map<string, string>, published: Set<string>) {
  const stale: string[] = [];
  for (const m of publicMembers) {
    if (!published.has(m.name)) continue;
    const deps = (await npmView(`${m.name}@${m.manifest.version}`, "dependencies")) ?? {};
    for (const [dep, range] of Object.entries<string>(deps)) {
      const local = versions.get(dep);
      if (local && !semver.satisfies(local, range)) {
        stale.push(`${m.name}@${m.manifest.version} needs ${dep} ${range}, and ${dep} is ${local}. Bump ${m.repo}.`);
      }
    }
  }
  return stale;
}

function bump(repo: string, to: string, members: Member[]) {
  const inRepo = members.filter((m) => m.repo === repo);
  if (!inRepo.length) fail(`no workspace members in ${repo}`);
  const current = inRepo.find((m) => m.manifest.private !== true)?.manifest.version ?? inRepo[0].manifest.version;
  const [major, minor, patch] = current.split(/[.-]/).map(Number);
  const next =
    to === "major" ? `${major + 1}.0.0`
    : to === "minor" ? `${major}.${minor + 1}.0`
    : to === "patch" ? `${major}.${minor}.${patch + 1}`
    : to;
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next)) fail(`not a semver version or level: ${to}`);
  // Every package in the repo shares the repo's version, plus the repo root manifest when it is not a member.
  const paths = inRepo.map((m) => join(m.dir, "package.json"));
  const rootManifest = join(CORE, repo, "package.json");
  if (existsSync(rootManifest) && !paths.includes(rootManifest)) paths.push(rootManifest);
  // Edit only the version line, so the rest of each manifest keeps its formatting.
  for (const path of paths) {
    const raw = readFileSync(path, "utf8");
    if (!/"version":\s*"[^"]*"/.test(raw)) fail(`${path} has no version field`);
    writeFileSync(path, raw.replace(/"version":\s*"[^"]*"/, `"version": "${next}"`));
  }
  console.log(`${repo}: ${current} → ${next} in ${paths.length} manifests. Commit them in ${repo}, then run bun run release.`);
}

// ---------------------------------------------------------------------------

const members = workspaceMembers();

if (args[0] === "bump") {
  if (!args[1] || !args[2]) fail("usage: bun scripts/release.ts bump <repo> <patch|minor|major|x.y.z>");
  bump(args[1], args[2], members);
  process.exit(0);
}

const allNames = new Set(members.map((m) => m.name));
const publicMembers = dependencyOrder(members.filter((m) => m.manifest.private !== true), allNames);
const versions = new Map(publicMembers.map((m) => [m.name, m.manifest.version as string]));

const published = new Set<string>();
for (const m of publicMembers) {
  if ((await npmView(`${m.name}@${m.manifest.version}`, "version")) === m.manifest.version) published.add(m.name);
}
const toPublish = publicMembers.filter((m) => !published.has(m.name));
const stale = await staleDependents(publicMembers, versions, published);

console.log(`${publicMembers.length} public packages, in publish order:`);
for (const m of publicMembers) {
  console.log(`  ${published.has(m.name) ? "on npm " : "publish"}  ${m.name}@${m.manifest.version}`);
}
for (const line of stale) console.log(`⚠ ${line}`);
if (CHECK) process.exit(0);
if (stale.length) fail("bump the repos above first, so every published range accepts the local versions");
if (!toPublish.length) {
  console.log("Nothing to publish. Bump a repo with: bun run release bump <repo> <patch|minor|major>");
  process.exit(0);
}

/** Entry points (main, types, bin, exports) that the package's `files` list leaves out of the tarball. */
async function missingEntryPoints(m: Member): Promise<string[]> {
  const proc = Bun.spawn(["npm", "pack", "--dry-run", "--json"], { cwd: m.dir, stdout: "pipe", stderr: "ignore" });
  // A prepack script (design-system's build) prints to stdout before npm's JSON.
  const out = await new Response(proc.stdout).text();
  const json = out.slice(out.search(/^\[/m));
  const packed: string[] = JSON.parse(json)[0].files.map((f: { path: string }) => f.path);
  const flat = (e: unknown): string[] =>
    typeof e === "string" ? [e] : e && typeof e === "object" ? Object.values(e).flatMap(flat) : [];
  const { main, types, bin, exports } = m.manifest;
  const targets = [main, types, ...flat(bin), ...flat(exports)].filter(Boolean).map((t: string) => t.replace(/^\.\//, ""));
  const missing = targets.filter((t) =>
    t.includes("*") ? !packed.some((f) => f.startsWith(t.split("*")[0])) : !packed.includes(t),
  );
  return [...new Set(missing)];
}
for (const m of toPublish) {
  const missing = await missingEntryPoints(m);
  if (missing.length) fail(`${m.name} exports files its "files" list leaves out: ${missing.join(", ")}`);
}

// npm ships a LICENSE only from the package folder. A package without its own
// gets a copy of its repo's LICENSE for the publish.
function licenseSource(m: Member): string | undefined {
  if (existsSync(join(m.dir, "LICENSE"))) return undefined;
  const repoLicense = join(CORE, m.repo, "LICENSE");
  if (!existsSync(repoLicense)) fail(`${m.name} has no LICENSE, and neither does ${m.repo}. Add one before publishing.`);
  return repoLicense;
}
for (const m of toPublish) licenseSource(m);

let count = 0;
for (const m of toPublish) {
  writeJson(join(m.dir, "package.json"), publishManifest(m, versions), m.raw);
  const license = licenseSource(m);
  if (license) copyFileSync(license, join(m.dir, "LICENSE"));
  const restore = () => {
    writeFileSync(join(m.dir, "package.json"), m.raw);
    if (license) rmSync(join(m.dir, "LICENSE"), { force: true });
  };
  process.once("SIGINT", () => {
    restore();
    process.exit(130);
  });
  try {
    const cmd = ["npm", "publish", ...(DRY_RUN ? ["--dry-run"] : [])];
    const proc = Bun.spawn(cmd, { cwd: m.dir, stdio: ["inherit", "inherit", "inherit"] });
    if ((await proc.exited) !== 0) fail(`npm publish failed for ${m.name}. Fix it, then run the same command again.`);
  } finally {
    restore();
    process.removeAllListeners("SIGINT");
  }
  count++;
  console.log(`✓ ${m.name}@${m.manifest.version}${DRY_RUN ? " (dry run)" : ""}`);
}
console.log(`\n${count} published${DRY_RUN ? " (dry run)" : ""}.`);
