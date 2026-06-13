// Node tests for the pure logic in .githooks/ai_commit.mjs.
// Mirrors tests/test_ai_commit.py so the port can be cross-checked 1:1.
// Run with:  node --test tests/test_ai_commit.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

function tmpGitRepo() {
  const root = mkdtempSync(join(tmpdir(), "nc-git-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "t@t.dev"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  return root;
}

const here = dirname(fileURLToPath(import.meta.url));
const aicPath = join(here, "..", ".githooks", "ai_commit.mjs");
const aic = await import(pathToFileURL(aicPath).href);

// Local SSE server helpers for callLlm tests (no network, no keys).
function sseServer(chunks) {
  return createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const c of chunks) res.write(c);
    res.end();
  });
}
function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
}

test("parseSemver: valid", () => {
  assert.deepEqual(aic.parseSemver("1.2.3"), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: null,
    build: null,
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
  assert.equal(aic.isValidCommitMessage("Feat: add"), false); // uppercase type
  assert.equal(aic.isValidCommitMessage("feat: добавить"), false); // cyrillic
  assert.equal(aic.isValidCommitMessage("nope: x"), false); // unknown type
  assert.equal(aic.isValidCommitMessage(""), false);
});

test("cleanLlmResponse: strip markdown", () => {
  assert.equal(aic.cleanLlmResponse("**feat: add thing**"), "feat: add thing");
});

test("cleanLlmResponse: skip preamble", () => {
  assert.equal(aic.cleanLlmResponse("Here is the commit:\nfeat: add x"), "feat: add x");
});

test("cleanLlmResponse: subject + body", () => {
  assert.equal(
    aic.cleanLlmResponse("feat: add\n\nbecause reasons"),
    "feat: add\n\nbecause reasons",
  );
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
  assert.deepEqual(aic.extractJson('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(aic.extractJson('Sure! Here:\n{"a": 1}\nDone'), { a: 1 });
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

// ── slice 2 ──

test("readCommitignore: strips comments and blanks", () => {
  const text = "# comment\n\n.githooks/\n  ai_commit.py  \n# another\n.env\n";
  assert.deepEqual(aic.readCommitignore(text), [".githooks/", "ai_commit.py", ".env"]);
});

test("CommitignoreMatcher: bare name, dir, glob, anchor, negation", () => {
  const m = new aic.CommitignoreMatcher([
    ".githooks/",
    "ai_commit.py",
    ".env",
    "*.log",
    "/root.txt",
    "!keep.log",
  ]);
  assert.equal(m.ignores(".githooks/ai_commit.py"), true);
  assert.equal(m.ignores("src/ai_commit.py"), true); // bare name at any depth
  assert.equal(m.ignores(".env"), true);
  assert.equal(m.ignores("a/b.log"), true); // *.log anywhere
  assert.equal(m.ignores("keep.log"), false); // negated after *.log
  assert.equal(m.ignores("root.txt"), true); // anchored at root
  assert.equal(m.ignores("sub/root.txt"), false); // anchored: not nested
  assert.equal(m.ignores("src/app.js"), false);
});

test("CommitignoreMatcher: ** double-star", () => {
  const m = new aic.CommitignoreMatcher(["**/node_modules/", "build/**"]);
  assert.equal(m.ignores("a/b/node_modules/x.js"), true);
  assert.equal(m.ignores("node_modules/x.js"), true);
  assert.equal(m.ignores("build/out/app.js"), true);
  assert.equal(m.ignores("src/app.js"), false);
});

test("resolveConfig: defaults (groq)", () => {
  const c = aic.resolveConfig({}, {});
  assert.equal(c.provider, "groq");
  assert.ok(c.apiUrl.includes("groq.com"));
  assert.equal(c.needsKey, true);
  assert.equal(c.model, "llama-3.1-8b-instant");
  assert.equal(c.addCoauthor, true);
  assert.equal(c.bumpVersion, false);
  assert.equal(c.language, "ru");
  assert.equal(c.apiKey, "");
});

test("resolveConfig: ollama needs no key", () => {
  const c = aic.resolveConfig({ provider: "ollama" }, {});
  assert.equal(c.needsKey, false);
  assert.ok(c.apiUrl.includes("11434"));
  assert.equal(c.model, "llama3.1");
});

test("resolveConfig: key from env, then config wins", () => {
  assert.equal(
    aic.resolveConfig({ provider: "openai" }, { OPENAI_API_KEY: "sk-env" }).apiKey,
    "sk-env",
  );
  assert.equal(
    aic.resolveConfig({ provider: "openai", apiKey: "sk-cfg" }, { OPENAI_API_KEY: "sk-env" })
      .apiKey,
    "sk-cfg",
  );
});

test("resolveConfig: custom provider + apiUrl, custom types", () => {
  const c = aic.resolveConfig(
    { provider: "custom", apiUrl: "http://x/v1/chat/completions", customTypes: ["hotfix"] },
    {},
  );
  assert.equal(c.apiUrl, "http://x/v1/chat/completions");
  assert.equal(c.needsKey, false);
  assert.ok(c.validTypes.includes("hotfix"));
  assert.ok(c.systemPrompt.includes("hotfix"));
});

test("filterDiffLines: keeps +/- under # File, drops ignored files", () => {
  const raw = [
    "diff --git a/src/app.js b/src/app.js",
    "index abc..def 100644",
    "--- a/src/app.js",
    "+++ b/src/app.js",
    "@@ -1 +1 @@",
    "-old line",
    "+new line",
    "diff --git a/secret.env b/secret.env",
    "--- a/secret.env",
    "+++ b/secret.env",
    "+API_TOKEN=leak",
  ].join("\n");
  const m = new aic.CommitignoreMatcher(["*.env"]);
  const out = aic.filterDiffLines(raw, m);
  assert.ok(out.includes("# File: src/app.js"));
  assert.ok(out.includes("-old line"));
  assert.ok(out.includes("+new line"));
  assert.ok(!out.includes("secret.env"));
  assert.ok(!out.includes("API_TOKEN"));
});

// ── slice 3: streaming LLM call ──

test("callLlm: parses an SSE stream", async () => {
  const server = sseServer([
    'data: {"choices":[{"delta":{"content":"feat: "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"add thing"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const port = await listen(server);
  try {
    const cfg = {
      provider: "test",
      apiUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "",
      needsKey: false,
      model: "m",
    };
    const out = await aic.callLlm([{ role: "user", content: "x" }], cfg, { echo: false });
    assert.equal(out, "feat: add thing");
  } finally {
    server.close();
  }
});

test("callLlm: clean=false returns raw text", async () => {
  const server = sseServer([
    'data: {"choices":[{"delta":{"content":"Here is:\\nfeat: x"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const port = await listen(server);
  try {
    const cfg = {
      provider: "test",
      apiUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "",
      needsKey: false,
      model: "m",
    };
    const out = await aic.callLlm([{ role: "user", content: "x" }], cfg, {
      echo: false,
      clean: false,
    });
    assert.equal(out, "Here is:\nfeat: x");
  } finally {
    server.close();
  }
});

test("callLlm: 429 rejects with rate-limit message", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(429);
    res.end("slow down");
  });
  const port = await listen(server);
  try {
    const cfg = {
      provider: "test",
      apiUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "",
      needsKey: false,
      model: "m",
    };
    await assert.rejects(
      () => aic.callLlm([{ role: "user", content: "x" }], cfg, { echo: false }),
      /rate limit/i,
    );
  } finally {
    server.close();
  }
});

test("callLlm: missing key rejects", async () => {
  await assert.rejects(
    () =>
      aic.callLlm(
        [],
        {
          provider: "groq",
          needsKey: true,
          apiKey: "",
          apiUrl: "http://x/v1",
          providerEnv: "GROQ_API_KEY",
        },
        { echo: false },
      ),
    /API key/,
  );
});

test("generateCommitMessage: returns a validated message", async () => {
  const server = sseServer([
    'data: {"choices":[{"delta":{"content":"feat: add a real thing"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const port = await listen(server);
  try {
    const cfg = aic.resolveConfig(
      { provider: "custom", apiUrl: `http://127.0.0.1:${port}/v1` },
      {},
    );
    const msg = await aic.generateCommitMessage("# File: a.js\n+x", cfg, { echo: false });
    assert.equal(msg, "feat: add a real thing");
  } finally {
    server.close();
  }
});

test("generateCommitMessage: null after repeated failures", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  const port = await listen(server);
  try {
    const cfg = aic.resolveConfig(
      { provider: "custom", apiUrl: `http://127.0.0.1:${port}/v1` },
      {},
    );
    const msg = await aic.generateCommitMessage("diff", cfg, { echo: false });
    assert.equal(msg, null);
  } finally {
    server.close();
  }
});

// ── slice 4: version bump ──

test("tomlHandle: peek + set in [package], preserves other lines", () => {
  const toml = '[package]\nname = "x"\nversion = "1.2.3"\n';
  assert.deepEqual(aic.tomlHandle(toml, "__PEEK__", ["package"]), [null, "1.2.3"]);
  const [out, old] = aic.tomlHandle(toml, "2.0.0", ["package"]);
  assert.equal(old, "1.2.3");
  assert.ok(out.includes('version = "2.0.0"'));
  assert.ok(out.includes('name = "x"'));
});

test("discoverManifests: finds manifests, skips node_modules", () => {
  const root = mkdtempSync(join(tmpdir(), "nc-disc-"));
  try {
    writeFileSync(join(root, "package.json"), '{"version":"1.0.0"}');
    mkdirSync(join(root, "pkg"));
    writeFileSync(join(root, "pkg", "pyproject.toml"), '[project]\nversion = "1.0.0"\n');
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(root, "node_modules", "dep"));
    writeFileSync(join(root, "node_modules", "dep", "package.json"), '{"version":"9.9.9"}');

    const found = aic.discoverManifests(root);
    const rels = found.map((m) => m.path.slice(root.length + 1));
    assert.ok(rels.includes("package.json"));
    assert.ok(rels.some((r) => r.endsWith("pyproject.toml")));
    assert.ok(!rels.some((r) => r.includes("node_modules")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bumpProjectVersion: bumps package.json + pyproject.toml", () => {
  const root = mkdtempSync(join(tmpdir(), "nc-bump-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "x", version: "1.2.3" }, null, 2)}\n`,
    );
    writeFileSync(join(root, "pyproject.toml"), '[project]\nname = "x"\nversion = "1.2.3"\n');

    const bumps = aic.bumpProjectVersion("minor", "feat: add", root);
    const byFile = Object.fromEntries(bumps.map((b) => [b[0], b[2]]));
    assert.equal(byFile["package.json"], "1.3.0");
    assert.equal(byFile["pyproject.toml"], "1.3.0");
    assert.ok(readFileSync(join(root, "package.json"), "utf8").includes('"1.3.0"'));
    assert.ok(readFileSync(join(root, "pyproject.toml"), "utf8").includes('version = "1.3.0"'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("getManifests: cache is keyed by repoRoot (no cross-repo bleed)", () => {
  const a = mkdtempSync(join(tmpdir(), "nc-cache-a-"));
  const b = mkdtempSync(join(tmpdir(), "nc-cache-b-"));
  try {
    writeFileSync(join(a, "package.json"), '{"version":"1.0.0"}');
    writeFileSync(join(b, "Cargo.toml"), '[package]\nversion = "1.0.0"\n');
    assert.deepEqual(
      aic.getManifests(a).map((m) => m.def.name),
      ["package.json"],
    );
    // With the old non-keyed global cache this returned a's manifests instead.
    assert.deepEqual(
      aic.getManifests(b).map((m) => m.def.name),
      ["Cargo.toml"],
    );
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

// ── slice 5: main flow + subcommands ──

test("composeMessage: bump footer + co-author", () => {
  const out = aic.composeMessage("feat: x", {
    bumps: [["package.json", "1.0.0", "1.1.0"]],
    kind: "minor",
    addCoauthor: true,
  });
  assert.ok(out.startsWith("feat: x"));
  assert.ok(out.includes("Bump version (minor):"));
  assert.ok(out.includes("package.json: 1.0.0 → 1.1.0"));
  assert.ok(out.includes("Co-authored-by: RXCommit"));
  assert.equal(aic.composeMessage("fix: y", {}), "fix: y");
});

test("checkConflictingHooks: detects .husky, clean repo is null", () => {
  const root = mkdtempSync(join(tmpdir(), "nc-conf-"));
  try {
    assert.equal(aic.checkConflictingHooks(root), null);
    mkdirSync(join(root, ".husky"));
    assert.ok(aic.checkConflictingHooks(root).includes(".husky"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildPrInfo: error when no commits ahead of base (no LLM)", async () => {
  const info = await aic.buildPrInfo("HEAD", aic.resolveConfig({ provider: "ollama" }, {}));
  assert.ok(info.error && /No commits/.test(info.error));
});

test("buildSplitPlan: error when nothing staged (no LLM)", async () => {
  const repo = tmpGitRepo();
  const cwd0 = process.cwd();
  try {
    process.chdir(repo);
    const plan = await aic.buildSplitPlan(aic.resolveConfig({ provider: "ollama" }, {}));
    assert.ok(/No staged changes/.test(plan.error || ""));
  } finally {
    process.chdir(cwd0);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("main: end-to-end writes the generated message into the commit file", async () => {
  const repo = tmpGitRepo();
  const server = sseServer([
    'data: {"choices":[{"delta":{"content":"feat: add greeting"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const port = await listen(server);
  const cwd0 = process.cwd();
  try {
    writeFileSync(join(repo, "hello.txt"), "hi there\n");
    spawnSync("git", ["add", "hello.txt"], { cwd: repo });
    process.chdir(repo);
    const cfg = aic.resolveConfig(
      {
        provider: "custom",
        apiUrl: `http://127.0.0.1:${port}/v1`,
        coauthor: true,
        bumpVersion: false,
      },
      {},
    );
    const msgFile = join(repo, "MSG");
    writeFileSync(msgFile, "");
    await aic.main(msgFile, cfg, { echo: false });
    const written = readFileSync(msgFile, "utf8");
    assert.ok(written.includes("feat: add greeting"), written);
    assert.ok(written.includes("Co-authored-by: RXCommit"));
  } finally {
    process.chdir(cwd0);
    server.close();
    rmSync(repo, { recursive: true, force: true });
  }
});
