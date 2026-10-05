#!/usr/bin/env bun
/** Bootstrap a fresh Codecaine Core meta-workspace checkout. */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const CORE = resolve(import.meta.dir, "..");

interface Member {
  dir: string;
  remote: string;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

let failed = false;

function report(status: "ok" | "fail", title: string, lines: string[] = []) {
  const symbol = { ok: "✓", fail: "✗" }[status];
  if (status === "fail") failed = true;
  console.log(`${symbol} ${title}`);
  for (const line of lines) console.log(`    ${line}`);
}

const members: Member[] = readJson(join(CORE, "members.json"));
const missing = members.filter((member) => !existsSync(join(CORE, member.dir, ".git")));

console.log(`Core workspace bootstrap — ${CORE}\n`);

for (const member of members) {
  if (!missing.includes(member)) report("ok", `${member.dir}: present`);
}

const clones = await Promise.all(
  missing.map(async (member) => {
    const proc = Bun.spawn(["git", "clone", "--recurse-submodules", member.remote, member.dir], {
      cwd: CORE,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { member, stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  }),
);

for (const clone of clones) {
  const output = [clone.stdout, clone.stderr].filter(Boolean);
  if (clone.exitCode === 0) report("ok", `${clone.member.dir}: cloned`, output);
  else report("fail", `${clone.member.dir}: clone failed`, output);
}

// @codecaine-ai/design-system sits beside the workspace (package.json workspaces
// lists ../../design-system). It has no git remote yet, so it cannot be cloned
// here, and bun install stops with "Workspace not found" without it.
const designSystem = resolve(CORE, "../../design-system");
const hasDesignSystem = existsSync(join(designSystem, "package.json"));
if (hasDesignSystem) {
  report("ok", "design-system: present at ../../design-system");
} else {
  report("fail", "design-system: missing at ../../design-system", [
    `expected: ${designSystem}`,
    "No git remote yet, so bootstrap cannot clone it. Copy or clone the design-system folder to that path, then rerun: bun run bootstrap",
  ]);
}

if (!hasDesignSystem) {
  report("fail", "Root install skipped: bun install needs ../../design-system (see above)");
} else if (missing.length > 0 || !existsSync(join(CORE, "node_modules"))) {
  const proc = Bun.spawn(["bun", "install"], { cwd: CORE, stdout: "inherit", stderr: "inherit" });
  const exitCode = await proc.exited;
  if (exitCode === 0) report("ok", "Root install complete");
  else report("fail", `Root install failed (exit ${exitCode})`);
} else {
  report("ok", "Root install skipped: all members and node_modules are present");
}

process.exit(failed ? 1 : 0);
