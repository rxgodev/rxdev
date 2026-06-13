import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "bin", "ac.js");

function run(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 10000 });
}

test("version", () => {
  const r = run("version");
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split("\n");
  const versionLine = lines.find((l) => l.trim().startsWith("v"));
  assert.ok(versionLine, "Expected a line starting with 'v'");
});

test("--help", () => {
  const r = run("--help");
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes("RXCommit"));
});

test("unknown command shows help", () => {
  const r = run("nonexistent");
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes("RXCommit"));
});
