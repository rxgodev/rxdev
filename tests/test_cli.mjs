import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "bin", "ac.js");

function run(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 10000 });
}

test("version", () => {
  const r = run("version");
  assert.equal(r.status, 0);
  assert.ok(r.stdout.trim().startsWith("v"));
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