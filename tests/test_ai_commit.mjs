// Node tests for the pure logic in .githooks/ai_commit.mjs.
// Mirrors tests/test_ai_commit.py so the port can be cross-checked 1:1.
// Run with:  node --test tests/test_ai_commit.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const aic = await import(join(here, "..", ".githooks", "ai_commit.mjs"));

test("parseSemver: valid", () => {
  assert.deepEqual(aic.parseSemver("1.2.3"), {
    major: 1, minor: 2, patch: 3, prerelease: null, build: null,
  });
});

test("parseSemver: prerelease + build", () => {
  const p = aic.parseSemver("1.2.3-beta.1+build5");
  assert.deepEqual(
    [p.major, p.minor, p.patch, p.prerelease, p.build],
    [1, 2, 3, "beta.1", "build5"],
  );
});

test("parseSemver: invalid", () => {
  for (const v of ["1.2", "v1.2.3", "01.2.3", "x", ""]) {
    assert.equal(aic.parseSemver(v), null, v);
  }
});

test("bumpSemver", () => {
  assert.equal(aic.bumpSemver("1.2.3", "major"), "2.0.0");
  assert.equal(aic.bumpSemver("1.2.3", "minor"), "1.3.0");
  assert.equal(aic.bumpSemver("1.2.3", "patch"), "1.2.4");
  assert.equal(aic.bumpSemver("0.0.0", "minor"), "0.1.0");
  assert.equal(aic.bumpSemver("nope", "patch"), null);
});

test("semverMax", () => {
  assert.equal(aic.semverMax("2.19.3", "2.0.0"), "2.19.3");
  assert.equal(aic.semverMax("2.0.0", "2.19.3"), "2.19.3");
  assert.equal(aic.semverMax(null, "1.0.0"), "1.0.0");
  assert.equal(aic.semverMax("1.0.0", null), "1.0.0");
  assert.equal(aic.semverMax("1.2.3", "1.2.3"), "1.2.3");
});

test("parseCommit: full", () => {
  const p = aic.parseCommit("feat(api)!: add oauth");
  assert.equal(p.type, "feat");
  assert.equal(p.scope, "api");
  assert.equal(p.breaking, true);
  assert.equal(p.description, "add oauth");
});

test("parseCommit: plain", () => {
  const p = aic.parseCommit("fix: bug");
  assert.equal(p.type, "fix");
  assert.equal(p.scope, null);
  assert.equal(p.breaking, false);
});

test("parseCommit: non-conforming", () => {
  assert.equal(aic.parseCommit("not a commit").type, null);
});

test("determineBumpKind", () => {
  assert.equal(aic.determineBumpKind("feat: x"), "minor");
  assert.equal(aic.determineBumpKind("fix: x"), "patch");
  assert.equal(aic.determineBumpKind("feat!: x"), "major");
  assert.equal(aic.determineBumpKind("docs: x"), "patch");
  assert.equal(aic.determineBumpKind("fix: x\n\nBREAKING CHANGE: y"), "major");
});

test("isValidCommitMessage: valid", () => {
  assert.equal(aic.isValidCommitMessage("feat: add thing"), true);
  assert.equal(aic.isValidCommitMessage("fix(api): handle timeout"), true);
});

test("isValidCommitMessage: invalid", () => {
  assert.equal(aic.isValidCommitMessage("feat: add thing."), false); // trailing period
  assert.equal(aic.isValidCommitMessage("Feat: add"), false);        // uppercase type
  assert.equal(aic.isValidCommitMessage("feat: добавить"), false);   // cyrillic
  assert.equal(aic.isValidCommitMessage("nope: x"), false);          // unknown type
  assert.equal(aic.isValidCommitMessage(""), false);
});

test("cleanLlmResponse: strip markdown", () => {
  assert.equal(aic.cleanLlmResponse("**feat: add thing**"), "feat: add thing");
});

test("cleanLlmResponse: skip preamble", () => {
  assert.equal(aic.cleanLlmResponse("Here is the commit:\nfeat: add x"), "feat: add x");
});

test("cleanLlmResponse: subject + body", () => {
  assert.equal(aic.cleanLlmResponse("feat: add\n\nbecause reasons"), "feat: add\n\nbecause reasons");
});

test("cleanLlmResponse: fallback when no subject", () => {
  assert.equal(aic.cleanLlmResponse("just some prose, no type"), "chore: update files");
});

test("normalizeType", () => {
  assert.equal(aic.normalizeType("Feat: Add thing"), "feat: Add thing");
  assert.equal(aic.normalizeType("FIX(api): x"), "fix(api): x");
});

test("jsonHandle: peek + set", () => {
  assert.deepEqual(aic.jsonHandle('{"version": "1.0.0"}', "__PEEK__"), [null, "1.0.0"]);
  const [content, old] = aic.jsonHandle('{"version": "1.0.0"}', "2.0.0");
  assert.equal(old, "1.0.0");
  assert.ok(content.includes('"2.0.0"'));
});

test("jsonHandle: no version", () => {
  assert.deepEqual(aic.jsonHandle('{"name": "x"}', "__PEEK__"), [null, null]);
});

test("plainHandle", () => {
  assert.deepEqual(aic.plainHandle("1.2.3\n", "__PEEK__"), [null, "1.2.3"]);
  assert.deepEqual(aic.plainHandle("1.2.3\n", "2.0.0"), ["2.0.0\n", "1.2.3"]);
  assert.deepEqual(aic.plainHandle("not a version\n", "__PEEK__"), [null, null]);
});

test("yamlHandle", () => {
  assert.deepEqual(aic.yamlHandle("version: 1.2.3\n", "__PEEK__"), [null, "1.2.3"]);
  const [content, old] = aic.yamlHandle("version: 1.2.3\n", "2.0.0");
  assert.equal(old, "1.2.3");
  assert.ok(content.includes("2.0.0"));
});

test("tomlRegexExtract", () => {
  assert.equal(aic.tomlRegexExtract('[package]\nversion = "1.0.0"\n', ["package"]), "1.0.0");
});

test("gradleHandle", () => {
  assert.deepEqual(aic.gradleHandle("version = '1.0.0'\n", "__PEEK__"), [null, "1.0.0"]);
});

test("csprojHandle", () => {
  assert.deepEqual(aic.csprojHandle("<Version>1.0.0</Version>", "__PEEK__"), [null, "1.0.0"]);
});

test("gemspecHandle", () => {
  assert.deepEqual(aic.gemspecHandle('spec.version = "1.0.0"', "__PEEK__"), [null, "1.0.0"]);
});

test("setupcfgHandle", () => {
  assert.deepEqual(aic.setupcfgHandle("version = 1.2.3\n", "__PEEK__"), [null, "1.2.3"]);
});

test("scanDiffForSecrets: detects + attributes", () => {
  const diff =
    "diff --git a/cfg.py b/cfg.py\n" +
    '+AWS = "AKIAIOSFODNN7EXAMPLE"\n' +
    "+normal = 42\n" +
    "diff --git a/x.txt b/x.txt\n" +
    '+token = "ghp_0123456789012345678901234567890123AB"\n';
  const findings = aic.scanDiffForSecrets(diff);
  const types = new Set(findings.map((f) => f.type));
  const files = new Set(findings.map((f) => f.file));
  assert.ok(types.has("AWS access key id"));
  assert.ok(types.has("GitHub token"));
  assert.deepEqual([...files].sort(), ["cfg.py", "x.txt"]);
});

test("scanDiffForSecrets: private key", () => {
  const diff = "diff --git a/k b/k\n+-----BEGIN RSA PRIVATE KEY-----\n";
  assert.ok(aic.scanDiffForSecrets(diff).some((f) => f.type === "Private key block"));
});

test("scanDiffForSecrets: clean diff", () => {
  assert.deepEqual(aic.scanDiffForSecrets("diff --git a/a b/a\n+hello world\n"), []);
});

test("scanDiffForSecrets: masking hides full secret", () => {
  const f = aic.scanDiffForSecrets('diff --git a/a b/a\n+x = "AKIAIOSFODNN7EXAMPLE"\n');
  assert.ok(!f[0].preview.includes("AKIAIOSFODNN7EXAMPLE"));
});

test("extractJson", () => {
  assert.deepEqual(aic.extractJson('{"a": 1}'), { a: 1 });
  assert.deepEqual(aic.extractJson("```json\n{\"a\": 1}\n```"), { a: 1 });
  assert.deepEqual(aic.extractJson("Sure! Here:\n{\"a\": 1}\nDone"), { a: 1 });
  assert.deepEqual(aic.extractJson('[{"x": 1}, {"y": 2}]'), [{ x: 1 }, { y: 2 }]);
  assert.equal(aic.extractJson("not json at all"), null);
});

test("groupCommits + renderChangelog", () => {
  const commits = [
    { hash: "aaa1111", subject: "feat(api): add oauth", body: "" },
    { hash: "bbb2222", subject: "fix: handle timeout", body: "" },
    { hash: "ccc3333", subject: "feat!: drop legacy", body: "" },
    { hash: "ddd4444", subject: "chore: bump deps", body: "" },
  ];
  const { groups, breaking, bump } = aic.groupCommits(commits);
  assert.equal(bump, "major");
  assert.equal(groups.feat.length, 2);
  assert.ok("fix" in groups);
  assert.ok(!("chore" in groups));
  assert.equal(breaking.length, 1);

  const md = aic.renderChangelog("3.0.0", groups, breaking, "2026-01-01");
  assert.ok(md.includes("## [3.0.0] - 2026-01-01"));
  assert.ok(md.includes("### ⚠ BREAKING CHANGES"));
  assert.ok(md.includes("### Features"));
  assert.ok(md.includes("**api:** add oauth"));
  assert.ok(md.includes("### Bug Fixes"));
});

test("generateFallbackMessage", () => {
  const msg = aic.generateFallbackMessage("# File: src/app.py\n+print(1)");
  assert.ok(msg.startsWith("refactor"), msg);
  assert.ok(msg.includes("app.py"));
});

test("providers registry", () => {
  for (const name of ["groq", "openai", "openrouter", "ollama"]) {
    assert.ok(name in aic.PROVIDERS);
  }
  assert.equal(aic.PROVIDERS.ollama.needsKey, false);
});

test("buildSystemPrompt", () => {
  const p = aic.buildSystemPrompt("feat, fix", "en", "");
  assert.ok(p.includes("Valid types: feat, fix"));
  assert.equal(aic.buildSystemPrompt("feat, fix", "en", "use {types}"), "use feat, fix");
});
