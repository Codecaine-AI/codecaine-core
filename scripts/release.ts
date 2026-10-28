#!/usr/bin/env bun
/**
 * Core release: publishes every public workspace member to npm at one shared
 * version.
 *
 * A member is public when its package.json has no `"private": true`. All public
 * members share one version, so a change that spans several packages ships as
 * one release, and installing one package pulls the exact versions of the
 * others.
 *
 * Usage:
 *   bun scripts/release.ts 0.2.0            # set versions, then publish
 *   bun scripts/release.ts 0.2.0 --dry-run  # set versions, then npm publish --dry-run
 *   bun scripts/release.ts --check          # list the public set and its order
 *
 * Publishing needs `npm login` with publish rights on the @codecaine-ai org.
 * With 2FA on writes, run it in a terminal so npm can prompt for each package.
 *
 * Why not `bun publish`: bun resolves `workspace:*` from the nearest
 * bun.lock, which is the member repo's standalone lockfile, not Core's. That
 * lockfile holds stale versions, so the script rewrites `workspace:*` itself.
 * Each manifest is restored after its publish. Versions already on npm are
 * skipped, so a failed run can be repeated.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Glob } from "bun";

const CORE = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const CHECK = args.includes("--check");
const VERSION = args.find((a) => !a.startsWith("--"));
const DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"] as const;

type Member = { name: string; dir: string; manifest: any; raw: string };

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function indentOf(raw: string): string {
  return raw.match(/^\{\n([ \t]+)/)?.[1] ?? "  ";
}

function writeManifest(m: Member, manifest: any) {
  writeFileSync(join(m.dir, "package.json"), JSON.stringify(manifest, null, indentOf(m.raw)) + "\n");
}

function workspaceMembers(): Member[] {
  const root = JSON.parse(readFileSync(join(CORE, "package.json"), "utf8"));
  const members: Member[] = [];
  for (const pattern of root.workspaces as string[]) {
    for (const file of new Glob(`${pattern}/package.json`).scanSync({ cwd: CORE, onlyFiles: true })) {
      const dir = join(CORE, file.slice(0, -"/package.json".length));
      const raw = readFileSync(join(dir, "package.json"), "utf8");
      const manifest = JSON.parse(raw);
      members.push({ name: manifest.name, dir, manifest, raw });
    }
  }
  return members;
}

function internalDeps(m: Member, names: Set<string>): string[] {
  const deps = new Set<string>();
  for (const field of DEP_FIELDS) {
    if (field === "devDependencies") continue;
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

/** Replaces every workspace: specifier on a public member with the release version. */
function publishManifest(m: Member, version: string, publicNames: Set<string>): any {
  const manifest = structuredClone(m.manifest);
  manifest.version = version;
  for (const field of DEP_FIELDS) {
    const deps = manifest[field];
    if (!deps) continue;
    for (const [dep, spec] of Object.entries(deps)) {
      if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
      if (field === "devDependencies") delete deps[dep];
      else if (publicNames.has(dep)) deps[dep] = version;
      else fail(`${m.name} has ${field}.${dep}: ${spec}, and ${dep} is not public`);
    }
  }
  if (JSON.stringify(manifest).includes('"workspace:')) fail(`${m.name} still has a workspace: specifier`);
  return manifest;
}

async function isPublished(name: string, version: string): Promise<boolean> {
  const proc = Bun.spawn(["npm", "view", `${name}@${version}`, "version"], { stdout: "pipe", stderr: "ignore" });
  return (await new Response(proc.stdout).text()).trim() === version;
}

// ---------------------------------------------------------------------------

const members = workspaceMembers();
const allNames = new Set(members.map((m) => m.name));
const publicMembers = dependencyOrder(members.filter((m) => m.manifest.private !== true), allNames);
const publicNames = new Set(publicMembers.map((m) => m.name));

if (CHECK || !VERSION) {
  console.log(`${publicMembers.length} public packages, in publish order:`);
  for (const m of publicMembers) console.log(`  ${m.name}@${m.manifest.version}  ${m.dir.slice(CORE.length + 1)}`);
  if (!CHECK) fail("usage: bun scripts/release.ts <version> [--dry-run]");
  process.exit(0);
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(VERSION)) fail(`not a semver version: ${VERSION}`);

// Set the shared version in every public manifest. These edits stay, so the
// repos record the released version.
for (const m of publicMembers) {
  m.manifest.version = VERSION;
  writeManifest(m, m.manifest);
  m.raw = readFileSync(join(m.dir, "package.json"), "utf8");
}
console.log(`Set ${publicMembers.length} manifests to ${VERSION}.`);

let published = 0;
for (const m of publicMembers) {
  if (!DRY_RUN && (await isPublished(m.name, VERSION))) {
    console.log(`- ${m.name}@${VERSION} is already on npm, skipped`);
    continue;
  }
  writeManifest(m, publishManifest(m, VERSION, publicNames));
  const restore = () => writeFileSync(join(m.dir, "package.json"), m.raw);
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
  published++;
  console.log(`✓ ${m.name}@${VERSION}${DRY_RUN ? " (dry run)" : ""}`);
}

console.log(`\n${published} published${DRY_RUN ? " (dry run)" : ""}. Commit the version bumps in each member repo.`);
