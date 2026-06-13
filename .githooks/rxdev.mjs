// RXDev — the prepare-commit-msg hook (Node, zero dependencies).
//
// Invoked by .githooks/prepare-commit-msg as `node rxdev.mjs "$1"`. It
// generates a Conventional Commit message from the staged diff via any
// OpenAI-compatible provider, with optional version bumping and secret scanning.
//
// Design rule: ZERO external dependencies. The file is copied standalone into
// each managed repo's .githooks/, so it uses Node built-ins only — including a
// self-contained .commitignore matcher (replacing Python's pathspec).
//
// It also exposes subcommands consumed in-process by the CLI:
//   --scan | --release | --pr | --split   (also runnable directly via node).
//
// Contents: semver, conventional-commit parsing, validation/cleaning, manifest
// version handlers, changelog, secret scanning, the provider registry + streaming
// LLM call, config/diff IO, version-bump orchestration, and the main() flow.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RXDEV_VERSION = "4.0.0";

export const DEFAULT_GROQ_MODEL = "llama-3.1-8b-instant";

export const DEFAULT_VALID_TYPES = [
  "feat",
  "fix",
  "chore",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "revert",
];

// Mutable in later slices (custom types from config); fixed for now.
const validTypes = new Set(DEFAULT_VALID_TYPES);

const PEEK = "__PEEK__";

// ── OpenAI-compatible providers (mirrored in bin/ac.js for the config UI) ──
export const PROVIDERS = {
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    env: "GROQ_API_KEY",
    defaultModel: "llama-3.1-8b-instant",
    needsKey: true,
  },
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
    env: "OPENAI_API_KEY",
    defaultModel: "gpt-4o-mini",
    needsKey: true,
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    env: "OPENROUTER_API_KEY",
    defaultModel: "openai/gpt-4o-mini",
    needsKey: true,
  },
  ollama: {
    url: "http://localhost:11434/v1/chat/completions",
    env: "OLLAMA_API_KEY",
    defaultModel: "llama3.1",
    needsKey: false,
  },
};
export const DEFAULT_PROVIDER = "groq";

export const REQUEST_TIMEOUT = 60; // seconds
export const MAX_ATTEMPTS = 3;
export const MAX_DIFF_LENGTH = 16000;

export function truncateDiffSmart(diff, maxChars = MAX_DIFF_LENGTH) {
  if (diff.length <= maxChars) {
    return { diff, truncated: false, totalChars: diff.length, includedChars: diff.length };
  }

  const fileBlocks = diff.split(/(?=^# File: )/m);
  let result = "";
  const totalChars = diff.length;
  let includedChars = 0;
  let truncated = false;
  let filesIncluded = 0;
  const filesTotal = fileBlocks.filter((b) => b.startsWith("# File:")).length;

  for (const block of fileBlocks) {
    if (includedChars + block.length <= maxChars) {
      result += block;
      includedChars += block.length;
      if (block.startsWith("# File:")) filesIncluded++;
    } else {
      truncated = true;
      break;
    }
  }

  if (truncated) {
    const remaining = filesTotal - filesIncluded;
    result += `\n\n[diff truncated: ${remaining} more file${remaining > 1 ? "s" : ""} not shown]`;
  }

  return { diff: result.trim(), truncated, totalChars, includedChars };
}

// ============================================================
//  SYSTEM PROMPT
// ============================================================

export const BODY_LANGUAGE_PROMPTS = {
  en: "Body: one short WHY sentence explaining this change. NO lists, NO file names, NO bullet points.",
  ru: "Body: ОДНО короткое предложение, объясняющее ЭТОТ изменение. БЕЗ списков, БЕЗ имён файлов.",
  de: "Body: EIN kurzer Satz, der DIESE Änderung erklärt. KEINE Listen, KEINE Dateinamen, KEINE Aufzählungen.",
  fr: "Body: UNE courte phrase expliquant CE changement. PAS de listes, PAS de noms de fichiers, PAS de puces.",
  zh: "Body: 一个短句解释这次变更。不要列表，不要文件名，不要项目符号。",
};

export const BAD_EXAMPLES =
  "CRITICAL rules:\n" +
  "- description starts with a lowercase letter (Add -> add, Fix -> fix)\n" +
  "- body is ONE short WHY sentence. NO lists, NO file names, NO line items\n" +
  "- feat = new feature for user, fix = bug fix, docs = docs only, refactor = code change with no behavior change\n" +
  "- Output ONLY the commit. No commentary.";

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTypeRegexStr(types) {
  return [...types]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|");
}

const TYPE_REGEX_STR = buildTypeRegexStr(validTypes);
const _TYPE_REGEX = new RegExp(`^(?:${TYPE_REGEX_STR})`, "i");
const _COMMIT_RE = new RegExp(`^(?:${TYPE_REGEX_STR})(?:\\([^)]*\\))?\\s*:`, "i");

const LANGUAGE_NAMES = {
  en: "English",
  ru: "Russian",
  de: "German",
  fr: "French",
  zh: "Chinese",
};

export function buildSystemPrompt(typesStr, language, customPrompt = "") {
  if (customPrompt) return customPrompt.replace("{types}", typesStr);
  const bodyPrompt = BODY_LANGUAGE_PROMPTS[language] || BODY_LANGUAGE_PROMPTS.ru;
  const langName = LANGUAGE_NAMES[language] || "Russian";
  return (
    "Generate a Conventional Commit message.\n\n" +
    "Format (MUST follow exactly):\n" +
    "type(scope): short description in lowercase\n\n" +
    "one short WHY sentence explaining this change\n\n" +
    `Valid types: ${typesStr}.\n` +
    `- ${bodyPrompt}\n` +
    `- IMPORTANT: The body MUST be written in ${langName}. The type and scope stay in English.\n` +
    `- The description after colon MUST be present and meaningful.\n` +
    `${BAD_EXAMPLES}`
  );
}

// ============================================================
//  VALIDATION / CLEANING
// ============================================================

export function isValidCommitMessage(msg, types = validTypes) {
  const typeSet = types instanceof Set ? types : new Set(types);
  if (!msg.trim()) return false;
  const subject = msg.trim().split("\n")[0].trim();
  if (/[а-яА-ЯёЁ]/.test(subject)) return false;

  const m = subject.match(/^([a-z]+)(?:\([^)]*\))?:\s*(.+)$/);
  if (!m) return false;

  const type = m[1];
  const description = m[2];
  if (!typeSet.has(type)) return false;
  if (subject.length > 150) return false;
  if (description.endsWith(".")) return false;
  return true;
}

export function normalizeType(text, typeRegexStr = TYPE_REGEX_STR) {
  const m = text.match(new RegExp(`^(${typeRegexStr})`, "i"));
  if (m) {
    const rest = text
      .slice(m[0].length)
      .replace(/^[: ]+/, "")
      .trim();
    const sm = rest.match(/^\(([^)]*)\)\s*:\s*(.*)/);
    if (sm) return `${m[1].toLowerCase()}(${sm[1]}): ${sm[2].trim()}`;
    return `${m[1].toLowerCase()}: ${rest}`;
  }
  return text;
}

const SKIP_PREFIXES = [
  "commit message",
  "response",
  "output",
  "result",
  "explanation",
  "changes",
  "summary",
  "diff",
  "analysis",
  "here is",
  "here's",
  "based on",
  "it appears",
  "a suitable",
  "the diff shows",
  "looking at",
  "in this commit",
];

const STOP_PREFIXES = [
  "however",
  "alternatively",
  "if you want",
  "it's worth noting",
  "the feat",
  "the fix",
  "the chore",
  "the docs",
  "the style",
  "the refactor",
  "the test",
  "the build",
  "the ci",
  "the revert",
  "or, if you",
  "or you could",
  "note:",
  "note that",
  "this commit message",
  "this commit follows",
  "in this case",
  "the conventional",
  "by the way",
  "as an alternative",
  "the diff shows",
  "type(scope)",
  "type(scope):",
];

export function cleanLlmResponse(text, typeRegexStr = TYPE_REGEX_STR) {
  const typeRegex = new RegExp(`^(?:${typeRegexStr})`, "i");
  const commitRe = new RegExp(`^(?:${typeRegexStr})(?:\\([^)]*\\))?\\s*:`, "i");

  text = text.replace(/\*{1,2}/g, "").replace(/`{1,3}/g, "");
  const lines = text.trim().split("\n");

  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const lowered = lines[i].trim().toLowerCase();
    if (SKIP_PREFIXES.some((p) => lowered.startsWith(p))) start = i + 1;
    else if (!lines[i].trim()) continue;
    else break;
  }

  const bodyLines = lines.slice(start);
  let subject = null;
  const bodyParts = [];
  let found = false;

  for (const line of bodyLines) {
    const stripped = line.trim();
    const lowered = stripped.toLowerCase();

    if (!found) {
      if (!stripped) continue;
      if (commitRe.test(stripped) || typeRegex.test(stripped)) {
        subject = stripped;
        found = true;
      }
      continue;
    }

    if (!stripped) {
      bodyParts.push("");
      continue;
    }
    if (STOP_PREFIXES.some((p) => lowered.startsWith(p))) break;
    if (commitRe.test(stripped)) break;
    bodyParts.push(stripped);
  }

  if (!subject) return "chore: update files";

  subject = normalizeType(subject, typeRegexStr).replace(/\.+$/, "");
  if (subject.length > 150) subject = `${subject.slice(0, 147)}...`;

  const body = bodyParts.join("\n").trim();
  return body ? `${subject}\n\n${body}` : subject;
}

// ============================================================
//  CONVENTIONAL COMMITS PARSING
// ============================================================

export function parseCommit(message) {
  const subject = message.trim().split("\n")[0].trim();
  const m = subject.match(/^([a-z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/);
  const result = {
    type: null,
    scope: null,
    breaking: false,
    description: null,
    footer_breaking: false,
  };
  if (m) {
    result.type = m[1];
    result.scope = m[2] ?? null;
    result.breaking = m[3] === "!";
    result.description = m[4].trim();
  }
  const body = message.slice(subject.length).trim();
  if (/BREAKING[- ]CHANGE\s*:/.test(body)) result.footer_breaking = true;
  return result;
}

export function determineBumpKind(message) {
  const p = parseCommit(message);
  if (p.breaking || p.footer_breaking) return "major";
  if (p.type === "feat") return "minor";
  return "patch";
}

// ============================================================
//  SEMVER
// ============================================================

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9a-zA-Z.-]+))?(?:\+([0-9a-zA-Z.-]+))?$/;

export function parseSemver(version) {
  const m = String(version).trim().match(SEMVER_RE);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
    build: m[5] ?? null,
  };
}

export function bumpSemver(version, kind) {
  const p = parseSemver(version);
  if (!p) return null;
  if (kind === "major") {
    p.major += 1;
    p.minor = 0;
    p.patch = 0;
  } else if (kind === "minor") {
    p.minor += 1;
    p.patch = 0;
  } else if (kind === "patch") {
    p.patch += 1;
  }
  let r = `${p.major}.${p.minor}.${p.patch}`;
  if (p.prerelease) r += `-${p.prerelease}`;
  if (p.build) r += `+${p.build}`;
  return r;
}

export function semverMax(a, b) {
  if (!a) return b;
  if (!b) return a;
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa) return b;
  if (!pb) return a;
  const ta = [pa.major, pa.minor, pa.patch];
  const tb = [pb.major, pb.minor, pb.patch];
  for (let i = 0; i < 3; i++) {
    if (ta[i] > tb[i]) return a;
    if (ta[i] < tb[i]) return b;
  }
  return a;
}

// ============================================================
//  MANIFEST VERSION HANDLERS — each returns [newContentOrNull, oldOrNull]
// ============================================================

function singleGroup(content, newVersion, regex, transformOld = (x) => x) {
  const m = regex.exec(content);
  if (!m) return [null, null];
  const oldRaw = m[1];
  const old = transformOld(oldRaw);
  if (newVersion === PEEK) return [null, old];
  const start = m.index + m[0].lastIndexOf(oldRaw);
  return [content.slice(0, start) + newVersion + content.slice(start + oldRaw.length), old];
}

export function jsonHandle(content, newVersion) {
  try {
    const data = JSON.parse(content);
    const old = data.version;
    if (old === undefined || old === null) return [null, null];
    if (newVersion === PEEK) return [null, old];
    data.version = newVersion;
    return [`${JSON.stringify(data, null, 2)}\n`, old];
  } catch {
    return [null, null];
  }
}

export function tomlRegexExtract(content, sections) {
  const sectionRe = /^\s*\[([^\]]+)\]\s*$/;
  const verRe = /^\s*version\s*=\s*"([^"]+)"/;
  let current = null;
  for (const line of content.split(/\r?\n/)) {
    const sm = line.match(sectionRe);
    if (sm) {
      current = sm[1].trim();
      continue;
    }
    if (sections.includes(current)) {
      const vm = line.match(verRe);
      if (vm) return vm[1];
    }
  }
  return null;
}

export function yamlHandle(content, newVersion) {
  return singleGroup(content, newVersion, /^version\s*:\s*['"]?([^'\s#]\S*)['"]?\s*$/m);
}

export function plainHandle(content, newVersion) {
  const lines = content.trim().split("\n");
  if (!lines.length) return [null, null];
  const old = lines[0].trim();
  if (!/^\d+\.\d+\.\d+/.test(old)) return [null, null];
  if (newVersion === PEEK) return [null, old];
  return [`${newVersion}\n`, old];
}

export function gradleHandle(content, newVersion) {
  return singleGroup(content, newVersion, /^\s*version\s*=\s*["']([^"']+)["']\s*$/m);
}

export function csprojHandle(content, newVersion) {
  let m = content.match(/<Version>([^<]+)<\/Version>/);
  if (!m) m = content.match(/<PackageVersion>([^<]+)<\/PackageVersion>/);
  if (!m) return [null, null];
  const old = m[1];
  if (newVersion === PEEK) return [null, old];
  const start = m.index + m[0].indexOf(old);
  return [content.slice(0, start) + newVersion + content.slice(start + old.length), old];
}

export function gemspecHandle(content, newVersion) {
  return singleGroup(content, newVersion, /\.version\s*=\s*["']([^"']+)["']/);
}

export function setupcfgHandle(content, newVersion) {
  return singleGroup(content, newVersion, /^\s*version\s*=\s*(.+)$/m, (s) => s.trim());
}

export function helmHandle(content, newVersion) {
  const verRe = /^(\s*version\s*:\s*["']?)([^"'\s#]+)(["']?\s*)$/m;
  const m = verRe.exec(content);
  if (!m) return [null, null];
  const old = m[2];
  if (newVersion === PEEK) return [null, old];
  const start = m.index + m[1].length;
  let newContent = content.slice(0, start) + newVersion + content.slice(start + old.length);
  const appRe = /^(\s*appVersion\s*:\s*["']?)([^"'\s#]+)(["']?\s*)$/m;
  newContent = newContent.replace(appRe, (_full, g1, _g2, g3) => g1 + newVersion + (g3 || ""));
  return [newContent, old];
}

// ============================================================
//  CHANGELOG
// ============================================================

export const SECTION_ORDER = [
  ["feat", "Features"],
  ["fix", "Bug Fixes"],
  ["perf", "Performance"],
  ["refactor", "Refactoring"],
  ["docs", "Documentation"],
  ["revert", "Reverts"],
];
const SECTION_KEYS = new Set(SECTION_ORDER.map(([k]) => k));

export function groupCommits(commits) {
  const groups = {};
  const breaking = [];
  const rank = { patch: 1, minor: 2, major: 3 };
  let bump = "patch";
  for (const c of commits) {
    const parsed = parseCommit(c.subject);
    const full = c.subject + (c.body ? `\n\n${c.body}` : "");
    const kind = determineBumpKind(full);
    if (rank[kind] > rank[bump]) bump = kind;
    if (parsed.breaking || parsed.footer_breaking) {
      breaking.push(`${parsed.description || c.subject} (${c.hash})`);
    }
    const t = parsed.type;
    if (SECTION_KEYS.has(t) && parsed.description) {
      if (!groups[t]) groups[t] = [];
      groups[t].push({ scope: parsed.scope, desc: parsed.description, hash: c.hash });
    }
  }
  return { groups, breaking, bump };
}

export function renderChangelog(version, groups, breaking, dateStr) {
  const lines = [`## [${version}] - ${dateStr}`, ""];
  if (breaking.length) {
    lines.push("### ⚠ BREAKING CHANGES");
    for (const b of breaking) lines.push(`- ${b}`);
    lines.push("");
  }
  for (const [key, title] of SECTION_ORDER) {
    const items = groups[key];
    if (!items?.length) continue;
    lines.push(`### ${title}`);
    for (const it of items) {
      const scope = it.scope ? `**${it.scope}:** ` : "";
      lines.push(`- ${scope}${it.desc} (${it.hash})`);
    }
    lines.push("");
  }
  return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}

// ============================================================
//  SECRET SCANNING (deterministic; never sent to an LLM)
// ============================================================

export const SECRET_PATTERNS = [
  ["AWS access key id", /AKIA[0-9A-Z]{16}/],
  ["AWS secret access key", /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}/i],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{36,}/],
  ["GitHub fine-grained PAT", /github_pat_[A-Za-z0-9_]{60,}/],
  ["Google API key", /AIza[0-9A-Za-z\-_]{35}/],
  ["Slack token", /xox[baprs]-[0-9A-Za-z-]{10,}/],
  ["Stripe secret key", /sk_live_[0-9A-Za-z]{24,}/],
  ["Private key block", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ["JSON Web Token", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  [
    "Hardcoded secret assignment",
    /(api[_-]?key|secret|token|passwd|password)\s*[=:]\s*['"]?[^'"\s]{8,}['"]?/i,
  ],
];

export function scanDiffForSecrets(diffText) {
  const findings = [];
  let currentFile = null;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git")) {
      const parts = line.split(/\s+/);
      if (parts.length) {
        currentFile = parts[parts.length - 1];
        if (currentFile.startsWith("b/")) currentFile = currentFile.slice(2);
      }
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      const added = line.slice(1);
      for (const [name, pat] of SECRET_PATTERNS) {
        const m = added.match(pat);
        if (m) {
          const s = m[0];
          const masked = s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : "…";
          findings.push({ file: currentFile, type: name, preview: masked });
          break;
        }
      }
    }
  }
  return findings;
}

// ============================================================
//  JSON EXTRACTION (lenient parse of LLM output)
// ============================================================

export function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(t);
  } catch {}
  for (const [open, close] of [
    ["[", "]"],
    ["{", "}"],
  ]) {
    const i = t.indexOf(open);
    const j = t.lastIndexOf(close);
    if (i !== -1 && j > i) {
      try {
        return JSON.parse(t.slice(i, j + 1));
      } catch {}
    }
  }
  return null;
}

// ============================================================
//  FALLBACK COMMIT GENERATOR
// ============================================================

const FALLBACK_EXT_TYPES = [
  [".js", "feat"],
  [".ts", "feat"],
  [".jsx", "feat"],
  [".tsx", "feat"],
  [".json", "config"],
  [".toml", "config"],
  [".yaml", "config"],
  [".yml", "config"],
  [".md", "docs"],
  [".css", "style"],
  [".scss", "style"],
  [".html", "feat"],
];
const FALLBACK_TYPE_MAP = {
  feat: "feat",
  fix: "fix",
  docs: "docs",
  style: "style",
  refactor: "refactor",
  test: "test",
  config: "chore",
};
const FALLBACK_SKIP_DIRS = new Set(["src", "lib", "app", "tests", ".githooks"]);

function posixDirname(f) {
  const i = f.lastIndexOf("/");
  return i === -1 ? "." : f.slice(0, i);
}
function posixBasename(f) {
  const i = f.lastIndexOf("/");
  return i === -1 ? f : f.slice(i + 1);
}

export function generateFallbackMessage(diff) {
  let parsedType = "chore";
  let parsedScope = null;
  const files = [];
  const seenScopes = new Set();

  for (const line of diff.split("\n")) {
    const m = line.match(/^# File: (.+)$/);
    if (!m) continue;
    const path = m[1];
    files.push(path);
    const lower = path.toLowerCase();

    // .py: feat if the path hints at a new feature, else refactor
    if (lower.endsWith(".py")) {
      const ptype = ["feat", "add", "impl", "new"].some((kw) => lower.includes(kw))
        ? "feat"
        : "refactor";
      parsedType = ptype;
    } else {
      for (const [pattern, ptype] of FALLBACK_EXT_TYPES) {
        if (lower.endsWith(pattern)) {
          if (ptype !== "config" && (ptype !== "docs" || parsedType === "chore")) {
            parsedType = ptype;
          }
          break;
        }
      }
    }

    if (/(\.test\.(js|ts|jsx|tsx)|_test\.py|\.spec\.(js|ts))$/.test(path)) parsedType = "test";

    const dirs = path.split("/");
    for (const d of dirs.slice(0, -1)) {
      if (!FALLBACK_SKIP_DIRS.has(d) && !d.startsWith(".")) seenScopes.add(d);
    }
  }

  if (seenScopes.size) {
    parsedScope = [...seenScopes].sort(
      (a, b) =>
        files.filter((f) => f.includes(b)).length - files.filter((f) => f.includes(a)).length,
    )[0];
  }

  const commitType = FALLBACK_TYPE_MAP[parsedType] || "chore";
  const shortFiles = files.slice(0, 5).map(posixBasename);
  let desc = shortFiles.join(", ");
  if (files.length > 5) desc += ` and ${files.length - 5} more`;

  const scope = parsedScope ? `(${parsedScope})` : "";
  const subject = `${commitType}${scope}: update ${desc}`;

  const dirChanges = {};
  for (const f of files) {
    const dirName = posixDirname(f) || ".";
    if (!dirChanges[dirName]) dirChanges[dirName] = [];
    dirChanges[dirName].push(posixBasename(f));
  }
  const bodyParts = [];
  for (const directory of Object.keys(dirChanges).sort()) {
    const names = dirChanges[directory];
    let fileList = names.slice(0, 3).join(", ");
    if (names.length > 3) fileList += ` and ${names.length - 3} more`;
    bodyParts.push(`- ${directory}: ${fileList}`);
  }

  return `${subject}\n\n${bodyParts.join("\n")}`;
}

// ============================================================
//  .commitignore MATCHER (zero-dependency replacement for pathspec)
//  Implements the gitignore subset relevant to .commitignore:
//  negation (!), dir-only (trailing /), anchoring (leading or internal /),
//  *, ?, **, and [...] character classes. Last matching pattern wins.
// ============================================================

function globToRegexBody(glob) {
  let re = "";
  const n = glob.length;
  let i = 0;
  while (i < n) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        let j = i;
        while (glob[j] === "*") j++;
        const prevChar = i > 0 ? glob[i - 1] : "";
        const nextChar = j < n ? glob[j] : "";
        const atStart = i === 0;
        const atEnd = j >= n;
        if ((atStart || prevChar === "/") && nextChar === "/") {
          re += "(?:.*/)?"; // "**/" → zero or more path segments
          i = j + 1; // also consume the following "/"
          continue;
        }
        if (prevChar === "/" && atEnd) {
          re += ".*"; // "/**" at end → everything below
          i = j;
          continue;
        }
        re += ".*"; // bare ** not bounded by slashes
        i = j;
        continue;
      }
      re += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (c === "[") {
      let cls = "[";
      i++;
      if (glob[i] === "!") {
        cls += "^";
        i++;
      }
      if (glob[i] === "]") {
        cls += "\\]";
        i++;
      }
      while (i < n && glob[i] !== "]") {
        if (glob[i] === "\\") {
          cls += `\\${glob[i + 1] ?? ""}`;
          i += 2;
        } else {
          cls += glob[i];
          i++;
        }
      }
      cls += "]";
      i++; // skip closing ]
      re += cls;
      continue;
    }
    re += c.replace(/[.*+?^${}()|[\]\\]/, "\\$&");
    i++;
  }
  return re;
}

function compilePattern(raw) {
  let pattern = raw;
  let negate = false;
  if (pattern.startsWith("!")) {
    negate = true;
    pattern = pattern.slice(1);
  }
  let dirOnly = false;
  if (pattern.endsWith("/")) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  let anchored = false;
  if (pattern.startsWith("/")) {
    anchored = true;
    pattern = pattern.slice(1);
  }
  if (pattern.includes("/")) anchored = true;

  const body = globToRegexBody(pattern);
  const prefix = anchored ? "^" : "(?:^|.*/)";
  const suffix = dirOnly ? "/.*$" : "(?:/.*)?$";
  return { re: new RegExp(prefix + body + suffix), negate };
}

export class CommitignoreMatcher {
  constructor(patterns) {
    this.compiled = [];
    for (const p of patterns) {
      const t = p.trim();
      if (!t || t.startsWith("#")) continue;
      try {
        this.compiled.push(compilePattern(t));
      } catch (e) {
        logMessage(`WARN: unparseable .commitignore pattern: ${t} (${e.message})`);
      }
    }
  }

  ignores(path) {
    let ignored = false;
    for (const { re, negate } of this.compiled) {
      if (re.test(path)) ignored = !negate;
    }
    return ignored;
  }
}

export function readCommitignore(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#")) out.push(t);
  }
  return out;
}

// ============================================================
//  CONFIG / PROVIDER RESOLUTION
// ============================================================

export function resolveConfig(userConfig = {}, env = process.env) {
  const provider = String(userConfig.provider || DEFAULT_PROVIDER).toLowerCase();
  const providerDef = PROVIDERS[provider] || {
    url: PROVIDERS[DEFAULT_PROVIDER].url,
    env: "RXDEV_API_KEY",
    defaultModel: DEFAULT_GROQ_MODEL,
    needsKey: false, // custom/unknown provider: don't block, let the endpoint decide
  };
  const apiKey =
    userConfig.apiKey ||
    env[providerDef.env] ||
    env.RXDEV_API_KEY ||
    env.NEURO_COMMIT_API_KEY ||
    "";
  const customTypes = Array.isArray(userConfig.customTypes) ? userConfig.customTypes : [];
  const allTypes = [...new Set([...DEFAULT_VALID_TYPES, ...customTypes])];
  const typesStr = [...allTypes].sort().join(", ");
  const language = userConfig.language || "ru";
  const customPrompt = userConfig.prompt || "";

  return {
    provider,
    apiUrl: userConfig.apiUrl || providerDef.url,
    apiKey,
    needsKey: providerDef.needsKey,
    providerEnv: providerDef.env,
    model: userConfig.model || providerDef.defaultModel,
    addCoauthor: userConfig.coauthor !== undefined ? userConfig.coauthor : true,
    bumpVersion: userConfig.bumpVersion || false,
    customTypes,
    validTypes: allTypes,
    language,
    systemPrompt: buildSystemPrompt(typesStr, language, customPrompt),
  };
}

// ============================================================
//  IO — config file, logging, git, staged diff
//  (No side effects at import time, unlike the Python module.)
// ============================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const OLD_CONFIG_DIR = join(homedir(), ".config", "ai-commit");
const CONFIG_DIR = join(homedir(), ".config", "rxdev");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const LOG_FILE = join(CONFIG_DIR, "rxdev_debug.log");

function migrateOldConfig() {
  if (existsSync(CONFIG_DIR) || !existsSync(OLD_CONFIG_DIR)) return;
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const oldConfig = join(OLD_CONFIG_DIR, "config.json");
    if (existsSync(oldConfig)) {
      writeFileSync(CONFIG_FILE, readFileSync(oldConfig, "utf8"));
    }
  } catch {}
}

export function loadProjectConfig(repoRoot) {
  const ymlPath = join(repoRoot || ".", "rxdev.yml");
  if (!existsSync(ymlPath)) return {};
  try {
    const content = readFileSync(ymlPath, "utf8");
    const config = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^(\w+):\s*(.+)$/);
      if (match) {
        let [, key, value] = match;
        value = value.trim();
        if (value === "true") value = true;
        else if (value === "false") value = false;
        else if (/^\d+$/.test(value)) value = parseInt(value, 10);
        else if (value.startsWith("[") && value.endsWith("]")) {
          value = value
            .slice(1, -1)
            .split(",")
            .map((s) => s.trim());
        }
        config[key] = value;
      }
    }
    return config;
  } catch {
    return {};
  }
}
const MAX_LOG_BYTES = 512 * 1024;

export function loadUserConfig() {
  if (existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    } catch (e) {
      process.stderr.write(`Failed to load config: ${e.message}\n`);
    }
  }
  return { coauthor: true, bumpVersion: false };
}

export function logMessage(message) {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      try {
        renameSync(LOG_FILE, `${LOG_FILE}.1`);
      } catch {}
    }
    appendFileSync(LOG_FILE, `${message}\n`, "utf8");
  } catch {
    // logging must never break the commit flow
  }
}

export function git(args, cwd) {
  try {
    const r = spawnSync("git", args, { encoding: "utf8", cwd, maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? r.stdout || "" : "";
  } catch {
    return "";
  }
}

export function findRepoRoot() {
  const out = git(["rev-parse", "--show-toplevel"]).trim();
  return out || null;
}

export function gatherContext(repoRoot) {
  const context = {};

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot).trim();
  if (branch) context.branch = branch;

  const recentCommits = git(["log", "--oneline", "-3", "--no-decorate"], repoRoot).trim();
  if (recentCommits) context.recentCommits = recentCommits;

  const issueMatch = branch?.match(/(?:fix|feat|feature|issue|ticket|task|bug)\/?[-_]?(\d+)/i);
  if (issueMatch) context.issueNumber = issueMatch[1];

  if (context.issueNumber) {
    try {
      const result = spawnSync(
        "gh",
        ["issue", "view", context.issueNumber, "--json", "title,body"],
        {
          encoding: "utf8",
          timeout: 5000,
        },
      );
      if (result.status === 0) {
        const issue = JSON.parse(result.stdout);
        if (issue.title) context.issueTitle = issue.title;
        if (issue.body) context.issueBody = issue.body.slice(0, 500);
      }
    } catch {}
  }

  return context;
}

export function filterDiffLines(rawDiff, matcher) {
  const filtered = [];
  let currentFile = null;
  for (const line of rawDiff.split(/\r?\n/)) {
    if (line.startsWith("diff --git")) {
      const parts = line.split(/\s+/);
      if (parts.length >= 3) {
        currentFile = parts[parts.length - 1];
        if (currentFile.startsWith("b/")) currentFile = currentFile.slice(2);
        if (matcher.ignores(currentFile)) {
          currentFile = null;
          continue;
        }
        filtered.push(`\n# File: ${currentFile}`);
      }
    } else if (
      currentFile &&
      (line.startsWith("+") || line.startsWith("-")) &&
      !line.startsWith("+++") &&
      !line.startsWith("---")
    ) {
      if (line.length > 1) filtered.push(line);
    }
  }
  return filtered.join("\n").trim();
}

export function getStagedDiff() {
  const nameOnly = git(["diff", "--cached", "--name-only"]);
  const stagedFiles = nameOnly
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!stagedFiles.length) return { diff: "", allIgnored: false };

  let patterns = [];
  const repoRoot = findRepoRoot();
  const commitignorePath = repoRoot ? join(repoRoot, ".commitignore") : ".commitignore";
  if (existsSync(commitignorePath)) {
    try {
      patterns = readCommitignore(readFileSync(commitignorePath, "utf8"));
    } catch {}
  }
  const matcher = new CommitignoreMatcher(patterns);

  const relevant = stagedFiles.filter((f) => !matcher.ignores(f));
  logMessage(`Staged files: ${JSON.stringify(stagedFiles)}`);
  logMessage(`Relevant files: ${JSON.stringify(relevant)}`);
  if (!relevant.length) return { diff: "", allIgnored: true };

  const raw = git(["diff", "--cached", "--no-color", "--unified=0", ...relevant]);
  let diffText = filterDiffLines(raw, matcher);

  if (!diffText && relevant.length) {
    const fileList = relevant.map((f) => `  - ${f}`).join("\n");
    diffText = `Files changed (binary or no text diff):\n${fileList}`;
  }
  return { diff: diffText, allIgnored: false };
}

// ============================================================
//  LLM CALL — streaming over built-in http/https (no fetch dep)
// ============================================================

export function callLlm(messages, cfg, opts = {}) {
  const {
    echo = true,
    clean = true,
    temperature = 0.0,
    maxTokens = null,
    typeRegexStr = TYPE_REGEX_STR,
  } = opts;

  if (cfg.needsKey && !cfg.apiKey) {
    return Promise.reject(
      new Error(
        `API key for provider '${cfg.provider}' is not set. Run 'rxdev config' to set ` +
          `your key, export ${cfg.providerEnv || "the provider env var"}, or switch ` +
          "provider (e.g. 'ollama' runs locally with no key).",
      ),
    );
  }

  const payload = { model: cfg.model, messages, stream: true, temperature };
  if (maxTokens) payload.max_tokens = maxTokens;
  const body = JSON.stringify(payload);

  let url;
  try {
    url = new URL(cfg.apiUrl);
  } catch {
    return Promise.reject(new Error(`Invalid API URL: ${cfg.apiUrl}`));
  }
  const isHttps = url.protocol === "https:";
  const reqFn = isHttps ? httpsRequest : httpRequest;

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": `rxdev/${RXDEV_VERSION}`,
    "Content-Length": Buffer.byteLength(body),
  };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  return new Promise((resolve, reject) => {
    const req = reqFn(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers,
        timeout: REQUEST_TIMEOUT * 1000,
      },
      (res) => {
        res.setEncoding("utf8");
        const status = res.statusCode;

        if (status !== 200) {
          let errBody = "";
          res.on("data", (d) => {
            errBody += d;
          });
          res.on("end", () => {
            if (status === 429) {
              logMessage(`${cfg.provider} rate limited: ${errBody}`);
              reject(
                new Error(`${cfg.provider} API rate limit exceeded. Wait a moment and retry.`),
              );
            } else {
              reject(new Error(`${cfg.provider} API HTTP ${status}: ${errBody}`));
            }
          });
          return;
        }

        let buffer = "";
        let text = "";
        const handleLine = (line) => {
          const trimmed = line.trim();
          if (!trimmed?.startsWith("data: ")) return;
          const dataStr = trimmed.slice(6);
          if (dataStr === "[DONE]") return;
          try {
            const chunk = JSON.parse(dataStr);
            const content = chunk.choices?.[0]?.delta?.content;
            if (content) {
              text += content;
              if (echo) process.stdout.write(content);
            }
          } catch (e) {
            logMessage(`WARN: malformed SSE chunk: ${e.message}`);
          }
        };

        res.on("data", (chunk) => {
          buffer += chunk;
          let idx = buffer.indexOf("\n");
          while (idx !== -1) {
            handleLine(buffer.slice(0, idx));
            buffer = buffer.slice(idx + 1);
            idx = buffer.indexOf("\n");
          }
        });
        res.on("end", () => {
          if (buffer) handleLine(buffer);
          if (echo) process.stdout.write("\n");
          const t = text.trim();
          resolve(clean ? cleanLlmResponse(t, typeRegexStr) : t);
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error(`${cfg.provider} API request timed out after ${REQUEST_TIMEOUT}s`));
    });
    req.on("error", (e) => {
      reject(new Error(`${cfg.provider} API error: ${e.message} (is ${cfg.apiUrl} reachable?)`));
    });
    req.write(body);
    req.end();
  });
}

export async function generateCommitMessage(diff, cfg, opts = {}) {
  const { echo = true, context = {} } = opts;
  const typeRegexStr = buildTypeRegexStr(cfg.validTypes || DEFAULT_VALID_TYPES);
  const typeSet = new Set(cfg.validTypes || DEFAULT_VALID_TYPES);

  let contextStr = "";
  if (context.branch) contextStr += `Branch: ${context.branch}\n`;
  if (context.recentCommits) contextStr += `Recent commits: ${context.recentCommits}\n`;
  if (context.issueNumber) contextStr += `Related issue: #${context.issueNumber}\n`;
  if (context.issueTitle) contextStr += `Issue title: ${context.issueTitle}\n`;
  if (context.issueBody) contextStr += `Issue description: ${context.issueBody}\n`;
  if (context.truncated) contextStr += `Note: diff was truncated, showing partial changes\n`;
  if (contextStr) contextStr = `\nContext:\n${contextStr}\n`;

  const userPrompt = `write a commit (subject + blank line + body explaining why) for:\n\n${contextStr}---\n${diff}\n---`;
  const messages = [
    { role: "system", content: cfg.systemPrompt },
    { role: "user", content: userPrompt },
  ];

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      logMessage(`Calling LLM (attempt ${attempt}/${MAX_ATTEMPTS})`);
      if (echo)
        process.stdout.write(`[${attempt}/${MAX_ATTEMPTS}] Generating commit message...\n\n`);
      const message = await callLlm(messages, cfg, { echo, typeRegexStr });

      if (!message || message.startsWith("#") || message.length < 10) {
        lastError = "Empty or too-short response";
        logMessage(`Response too short or invalid: ${JSON.stringify(message)}`);
        continue;
      }
      if (!isValidCommitMessage(message, typeSet)) {
        lastError = "Response did not match Conventional Commits format";
        logMessage(
          `Validation failed (attempt ${attempt}): ${JSON.stringify(message.slice(0, 120))}`,
        );
        continue;
      }
      logMessage(`SUCCESS on attempt ${attempt}`);
      return message;
    } catch (e) {
      lastError = e.message;
      logMessage(`FAILURE on attempt ${attempt}: ${e.message}`);
      if (attempt < MAX_ATTEMPTS && echo) process.stdout.write(`  Retry: ${e.message}\n`);
    }
  }
  logMessage(`All ${MAX_ATTEMPTS} attempts failed (${lastError}), caller should use fallback`);
  return null;
}

// ============================================================
//  VERSION BUMP — manifest registry, single-pass discovery, orchestration
// ============================================================

export function tomlReplace(content, sections, newVersion, old) {
  const sectionRe = /^\s*\[([^\]]+)\]\s*$/;
  const verRe = /^(\s*version\s*=\s*")([^"]+)(".*)$/;
  const out = [];
  let current = null;
  let replaced = false;
  for (const line of content.split(/(?<=\n)/)) {
    const stripped = line.replace(/\r?\n$/, "");
    const eol = line.slice(stripped.length);
    const sm = stripped.match(sectionRe);
    if (sm) {
      current = sm[1].trim();
      out.push(line);
      continue;
    }
    if (!replaced && sections.includes(current)) {
      const vm = stripped.match(verRe);
      if (vm && vm[2] === old) {
        out.push(vm[1] + newVersion + vm[3] + eol);
        replaced = true;
        continue;
      }
    }
    out.push(line);
  }
  if (!replaced) return [null, null];
  return [out.join(""), old];
}

export function tomlHandle(content, newVersion, sections) {
  const old = tomlRegexExtract(content, sections);
  if (old === null) return [null, null];
  if (newVersion === PEEK) return [null, old];
  return tomlReplace(content, sections, newVersion, old);
}

export const MANIFEST_DEFINITIONS = [
  { name: "package.json", patterns: ["package.json"], handler: jsonHandle },
  { name: "composer.json", patterns: ["composer.json"], handler: jsonHandle },
  {
    name: "Cargo.toml",
    patterns: ["Cargo.toml"],
    handler: (c, v) => tomlHandle(c, v, ["package"]),
  },
  {
    name: "pyproject.toml",
    patterns: ["pyproject.toml"],
    handler: (c, v) => tomlHandle(c, v, ["project", "tool.poetry"]),
  },
  { name: "Chart.yaml", patterns: ["Chart.yaml"], handler: helmHandle },
  { name: "pubspec.yaml", patterns: ["pubspec.yaml"], handler: yamlHandle },
  { name: "build.gradle", patterns: ["build.gradle"], handler: gradleHandle },
  { name: "build.gradle.kts", patterns: ["build.gradle.kts"], handler: gradleHandle },
  {
    name: "Version.props",
    patterns: ["Version.props", "Directory.Build.props"],
    handler: csprojHandle,
  },
  { name: "csproj", patterns: ["*.csproj"], handler: csprojHandle },
  { name: "gemspec", patterns: ["*.gemspec"], handler: gemspecHandle },
  { name: "setup.cfg", patterns: ["setup.cfg"], handler: setupcfgHandle },
  { name: "VERSION", patterns: ["VERSION"], handler: plainHandle },
  { name: "version.txt", patterns: ["version.txt"], handler: plainHandle },
  { name: ".bumpversion.cfg", patterns: [".bumpversion.cfg"], handler: setupcfgHandle },
];

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".eggs",
  "dist",
  "build",
  ".git2",
  ".svn",
]);

function _matchManifestPattern(name, pattern) {
  return pattern.startsWith("*.") ? name.endsWith(pattern.slice(1)) : name === pattern;
}

// Single tree walk (skips SKIP_DIRS at the boundary instead of descending into
// them like the Python rglob did — same result, far fewer syscalls).
function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

export function discoverManifests(repoRoot) {
  // Build lookup structures for efficient matching
  const exactNames = new Map(); // name -> def
  const suffixPatterns = []; // { suffix, def }

  for (const def of MANIFEST_DEFINITIONS) {
    for (const pattern of def.patterns) {
      if (pattern.startsWith("*.")) {
        suffixPatterns.push({ suffix: pattern.slice(1), def });
      } else {
        exactNames.set(pattern, def);
      }
    }
  }

  const allFiles = walkFiles(repoRoot);
  const found = [];
  const seen = new Set();

  for (const f of allFiles) {
    const name = basename(f);
    let matchedDef = null;

    // Check exact name matches first (cheaper)
    if (exactNames.has(name)) {
      matchedDef = exactNames.get(name);
    } else {
      // Check suffix patterns
      for (const { suffix, def } of suffixPatterns) {
        if (name.endsWith(suffix)) {
          matchedDef = def;
          break;
        }
      }
    }

    if (matchedDef && !seen.has(f)) {
      seen.add(f);
      found.push({ path: f, def: matchedDef });
    }
  }

  return found;
}

let _manifestCache = null;
export function getManifests(repoRoot) {
  if (!_manifestCache) _manifestCache = discoverManifests(repoRoot);
  return _manifestCache;
}

export function manifestGetVersion(content, def) {
  return def.handler(content, PEEK)[1];
}

export function manifestSetVersion(content, newVersion, def) {
  return def.handler(content, newVersion);
}

export function getLatestTagVersion(repoRoot) {
  const out = git(["tag", "--sort=-version:refname"], repoRoot);
  if (!out) return null;
  for (const raw of out.split(/\r?\n/)) {
    const tag = raw.trim().replace(/^v+/, "");
    if (SEMVER_RE.test(tag)) return tag;
  }
  return null;
}

export function getChangedFilesInScope(repoRoot, manifestRelPath) {
  const prefix = posixDirname(manifestRelPath);
  if (prefix === "." || prefix === "") return new Set();
  const out = git(["diff", "--cached", "--name-only"], repoRoot);
  const prefixSlash = `${prefix}/`;
  return new Set(out.split(/\r?\n/).filter((f) => f.startsWith(prefixSlash)));
}

export function shouldBumpManifest(manifestRelPath, repoRoot, message) {
  const parsed = parseCommit(message);
  if (["docs", "style", "test"].includes(parsed.type)) {
    if (getChangedFilesInScope(repoRoot, manifestRelPath).size === 0) return false;
  }
  return true;
}

export function bumpProjectVersion(kind, message = "", repoRoot = findRepoRoot()) {
  if (!repoRoot) return [];
  const manifests = getManifests(repoRoot);
  if (!manifests.length) {
    logMessage("bump: no manifests found in repo");
    return [];
  }

  const bumps = [];
  for (const { path, def } of manifests) {
    const relPath = relative(repoRoot, path).split(sep).join("/");
    let content;
    try {
      content = readFileSync(path, "utf8");
    } catch (e) {
      logMessage(`bump: cannot read ${relPath}: ${e.message}`);
      continue;
    }
    const oldVersion = manifestGetVersion(content, def);
    if (oldVersion == null) {
      logMessage(`bump: no version field in ${relPath}`);
      continue;
    }
    if (!shouldBumpManifest(relPath, repoRoot, message)) {
      logMessage(`bump: skipping ${relPath} (changes unrelated to this package)`);
      continue;
    }
    const newVersion = bumpSemver(oldVersion, kind);
    if (newVersion == null) {
      logMessage(`bump: cannot parse version '${oldVersion}' in ${relPath} as semver`);
      continue;
    }
    const [newContent] = manifestSetVersion(content, newVersion, def);
    if (newContent == null) continue;
    try {
      writeFileSync(path, newContent, "utf8");
    } catch (e) {
      logMessage(`bump: cannot write ${relPath}: ${e.message}`);
      continue;
    }
    logMessage(`bump: ${relPath} ${oldVersion} ${newVersion} (${kind})`);
    bumps.push([relPath, oldVersion, newVersion]);
  }
  return bumps;
}

// ============================================================
//  CONFLICT DETECTION
// ============================================================

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function checkConflictingHooks(repoRoot) {
  const conflicts = [];
  if (isDir(join(repoRoot, ".husky"))) {
    conflicts.push(
      ".husky directory detected — conflicts with RXDev hooks. Delete it or run `npx husky uninstall`.",
    );
  }
  if (existsSync(join(repoRoot, "lefthook.yml")) || existsSync(join(repoRoot, "lefthook.yaml"))) {
    conflicts.push("lefthook config detected — may conflict with RXDev hooks.");
  }
  if (existsSync(join(repoRoot, ".pre-commit-config.yaml"))) {
    conflicts.push(".pre-commit-config.yaml detected — may conflict with core.hooksPath.");
  }
  return conflicts.length ? conflicts.join("\n") : null;
}

// ============================================================
//  SUBCOMMANDS — scan / release / pr / split
// ============================================================

export function scanStagedSecrets() {
  return scanDiffForSecrets(git(["diff", "--cached", "--no-color", "--unified=0"]));
}

export function detectDefaultBranch() {
  const ref = git(["symbolic-ref", "refs/remotes/origin/HEAD"]).trim();
  if (ref) return ref.split("/").pop();
  for (const b of ["main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", b]).trim()) return b;
  }
  return "main";
}

export function collectCommits(revRange) {
  const out = git(["log", revRange, "--no-merges", "--pretty=format:%h%x1f%s%x1f%b%x1e"]);
  const commits = [];
  for (const rec of out.split("\x1e")) {
    const r = rec.replace(/^\n+|\n+$/g, "");
    if (!r.trim()) continue;
    const fields = r.split("\x1f");
    if (fields.length < 2) continue;
    commits.push({
      hash: fields[0].trim(),
      subject: fields[1].trim(),
      body: (fields[2] || "").trim(),
    });
  }
  return commits;
}

export function buildReleaseInfo(todayStr) {
  const repoRoot = findRepoRoot() || process.cwd();
  const lastTag = git(["describe", "--tags", "--abbrev=0"]).trim();
  const revRange = lastTag ? `${lastTag}..HEAD` : "HEAD";
  const commits = collectCommits(revRange);
  const { groups, breaking, bump } = groupCommits(commits);

  // Highest known version (tag or manifest), so a repo that tags less often
  // than it bumps its manifest never regresses.
  let current = getLatestTagVersion(repoRoot);
  for (const { path, def } of getManifests(repoRoot)) {
    try {
      const v = manifestGetVersion(readFileSync(path, "utf8"), def);
      if (v) current = semverMax(current, v);
    } catch {}
  }
  current = current || "0.0.0";
  const nextv = bumpSemver(current, bump) || current;
  const date = todayStr || new Date().toISOString().slice(0, 10);
  return {
    from: lastTag || null,
    current,
    next: nextv,
    bump,
    count: commits.length,
    breaking,
    changelog: renderChangelog(nextv, groups, breaking, date),
    has_tags: !!lastTag,
  };
}

const PR_SYSTEM_PROMPT =
  "You write concise GitHub pull request descriptions. Output ONLY a JSON object with " +
  'keys "title" and "body". title: one concise line (<72 chars), conventional style, no ' +
  "trailing period. body: GitHub-flavored markdown with a one-paragraph '## Summary', a " +
  "'## Changes' bullet list, and an optional '## Notes'. Do not wrap the JSON in code fences.";

export async function buildPrInfo(base, cfg) {
  base = base || detectDefaultBranch();
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const commits = collectCommits(`${base}..HEAD`);
  if (!commits.length) {
    return { error: `No commits on '${branch}' ahead of '${base}'.`, base, branch };
  }
  const diffstat = git(["diff", "--stat", `${base}..HEAD`]).slice(0, 2000);
  const commitText = commits
    .map((c) => `- ${c.subject}${c.body ? `\n  ${c.body}` : ""}`)
    .join("\n");
  const user = `Base branch: ${base}\nHead branch: ${branch}\n\nCommits:\n${commitText}\n\nDiff stat:\n${diffstat}`;

  let data;
  try {
    const raw = await callLlm(
      [
        { role: "system", content: PR_SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
      cfg,
      { echo: false, clean: false, temperature: 0.3, maxTokens: 900 },
    );
    data = extractJson(raw);
  } catch (e) {
    return { error: e.message, base, branch };
  }
  if (!data || typeof data !== "object" || !("title" in data) || !("body" in data)) {
    data = { title: commits[0].subject, body: `## Changes\n${commitText}` };
  }
  return { ...data, base, branch, count: commits.length };
}

const SPLIT_SYSTEM_PROMPT =
  "You split a set of staged changes into a minimal set of logical, independently-" +
  "reviewable git commits using Conventional Commits. Output ONLY a JSON array; each item " +
  'is {"message": "type(scope): subject", "files": ["path", ...], "reason": "short why"}. ' +
  "Every input file must appear in exactly one group. If the changes are cohesive, return a " +
  "single group. Use lowercase imperative subjects with no trailing period.";

function _groupFilesByModule(files) {
  const groups = {};
  for (const f of files) {
    const parts = f.split("/");
    let module = parts[0];
    if (
      parts.length > 1 &&
      !["src", "lib", "packages", "apps", "tests", "test", "__tests__"].includes(parts[0])
    ) {
      module = parts.slice(0, 2).join("/");
    }
    if (!groups[module]) groups[module] = [];
    groups[module].push(f);
  }
  return groups;
}

function inferCommitType(filename) {
  if (filename.match(/\.(test|spec)\.(js|ts|mjs|jsx|tsx)$/)) return "test";
  if (filename.match(/\.(md|txt|rst)$/)) return "docs";
  if (filename.match(/^(package|Cargo|pyproject|setup|build\.gradle)/)) return "chore";
  if (filename.match(/^\.(github|gitignore|commitignore|editorconfig)/)) return "chore";
  return null;
}

export async function buildSplitPlan(cfg) {
  const staged = git(["diff", "--cached", "--name-only"])
    .split(/\r?\n/)
    .filter((s) => s.trim());
  if (!staged.length) {
    return {
      error: "No staged changes. Stage files first with 'git add'.",
      groups: [],
      staged: [],
    };
  }

  const autoGroups = [];
  const needsLlm = [];
  for (const f of staged) {
    const inferredType = inferCommitType(f);
    if (inferredType) {
      autoGroups.push({ type: inferredType, file: f });
    } else {
      needsLlm.push(f);
    }
  }

  let llmGroups = [];
  if (needsLlm.length > 0) {
    const parts = needsLlm.map(
      (f) => `### ${f}\n${git(["diff", "--cached", "--unified=0", "--", f]).slice(0, 700)}`,
    );
    const user = `Staged files and their diffs:\n\n${parts.join("\n\n")}`.slice(0, 6000);

    let data;
    try {
      const raw = await callLlm(
        [
          { role: "system", content: SPLIT_SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
        cfg,
        { echo: false, clean: false, temperature: 0.1, maxTokens: 900 },
      );
      data = extractJson(raw);
    } catch (e) {
      return { error: e.message, groups: [], staged };
    }
    const groups = Array.isArray(data)
      ? data
      : data && Array.isArray(data.groups)
        ? data.groups
        : null;
    if (groups?.length) {
      llmGroups = groups;
    }
  }

  const assigned = [];
  const clean = [];

  for (const ag of autoGroups) {
    let target = clean.find((g) => g.message.startsWith(ag.type));
    if (!target) {
      target = { message: `${ag.type}: update`, files: [], reason: `auto-detected as ${ag.type}` };
      clean.push(target);
    }
    target.files.push(ag.file);
    assigned.push(ag.file);
  }

  for (const g of llmGroups) {
    if (!g || typeof g !== "object") continue;
    const files = (g.files || []).filter((f) => staged.includes(f) && !assigned.includes(f));
    if (!files.length) continue;
    assigned.push(...files);
    clean.push({
      message: String(g.message || "chore: update").trim(),
      files,
      reason: String(g.reason || "").trim(),
    });
  }

  const unassigned = staged.filter((f) => !assigned.includes(f));
  return { groups: clean, staged, unassigned };
}

const REVIEW_SYSTEM_PROMPT =
  "You are a senior code reviewer. You MUST review the code diff provided below. " +
  "Output a structured review with sections: " +
  "1. Summary (1-2 sentences about what changed) " +
  "2. Issues found (if any) with severity: critical/warning/suggestion " +
  "3. Suggestions for improvement (if any) " +
  "If no issues found, say 'No issues found. Code looks good.' " +
  "Do NOT ask for more code. Review what is provided.";

export async function buildReview(diff, cfg) {
  if (!diff || diff.trim().length === 0) {
    return { error: "No changes to review", issues: [], review: "" };
  }

  if (diff.trim().length < 50) {
    return { review: "Changes too small for meaningful review. Consider making larger changes.", issues: [], issueCount: 0 };
  }

  const userPrompt = `Review the following code changes:\n\n---\n${diff}\n---`;

  logMessage(`REVIEW: Sending ${diff.length} chars to LLM`);
  logMessage(`REVIEW: System prompt: ${REVIEW_SYSTEM_PROMPT.slice(0, 100)}...`);

  const reviewCfg = { ...cfg, model: "llama-3.3-70b-versatile" };

  let reviewText;
  try {
    reviewText = await callLlm(
      [
        { role: "system", content: REVIEW_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      reviewCfg,
      { echo: false, clean: false, temperature: 0.3, maxTokens: 1500 },
    );
  } catch (e) {
    logMessage(`REVIEW: LLM error: ${e.message}`);
    return { error: `LLM error: ${e.message}`, issues: [], review: "" };
  }

  logMessage(`REVIEW: LLM returned ${reviewText?.length || 0} chars: ${reviewText?.slice(0, 100)}...`);

  if (!reviewText || reviewText.trim().length === 0) {
    return { error: "LLM returned empty response", issues: [], review: "" };
  }

  const issues = [];
  const lines = reviewText.split("\n");
  let currentIssue = null;

  for (const line of lines) {
    const severityMatch = line.match(/\b(critical|warning|suggestion)\b/i);
    if (severityMatch) {
      if (currentIssue) issues.push(currentIssue);
      currentIssue = {
        severity: severityMatch[1].toLowerCase(),
        message: line.replace(/^[\s\-*]+/, "").trim(),
        file: null,
        line: null,
      };
    } else if (currentIssue && line.trim()) {
      currentIssue.message += ` ${line.trim()}`;
    }
  }
  if (currentIssue) issues.push(currentIssue);

  return { review: reviewText, issues, issueCount: issues.length };
}

export async function buildPrReview(_prNumber, cfg) {
  const prDiff = git(["diff", `origin/main...HEAD`, "--no-color"]);
  if (!prDiff) {
    return { error: "Could not fetch PR diff", issues: [] };
  }

  const truncated = prDiff.slice(0, MAX_DIFF_LENGTH);
  return buildReview(truncated, cfg);
}

export function analyzeCommits(revRange = "HEAD~20..HEAD", repoRoot) {
  let logOutput = git(["log", "--first-parent", "--pretty=format:%H %s", revRange], repoRoot);
  if (!logOutput) {
    logOutput = git(["log", "--first-parent", "--pretty=format:%H %s", "HEAD"], repoRoot);
  }
  if (!logOutput) return { total: 0, byType: {}, avgMessageLength: 0, breakingChanges: 0 };

  const commits = logOutput
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx === -1) return { hash: line, subject: "" };
      return { hash: line.slice(0, spaceIdx), subject: line.slice(spaceIdx + 1) };
    });

  const byType = {};
  let totalLength = 0;
  let breakingChanges = 0;

  for (const c of commits) {
    if (!c.subject) continue;
    const parsed = parseCommit(c.subject);
    if (parsed.type) {
      byType[parsed.type] = (byType[parsed.type] || 0) + 1;
    }
    totalLength += c.subject.length;
    if (parsed.breaking) breakingChanges++;
  }

  return {
    total: commits.length,
    byType,
    avgMessageLength: commits.length ? Math.round(totalLength / commits.length) : 0,
    breakingChanges,
  };
}

export function detectBadPractices(revRange = "HEAD~20..HEAD", repoRoot) {
  let logOutput = git(["log", "--first-parent", "--pretty=format:%H %s", revRange], repoRoot);
  if (!logOutput) logOutput = git(["log", "--first-parent", "--pretty=format:%H %s", "HEAD"], repoRoot);
  if (!logOutput) return [];

  const commits = logOutput
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx === -1) return { hash: line, subject: "" };
      return { hash: line.slice(0, spaceIdx), subject: line.slice(spaceIdx + 1) };
    });

  const issues = [];

  for (const c of commits) {
    if (!c.subject) continue;
    if (c.subject.length > 100) {
      issues.push({
        severity: "warning",
        message: `Long commit message (${c.subject.length} chars): ${c.subject.slice(0, 50)}...`,
        hash: c.hash,
      });
    }
    const parsed = parseCommit(c.subject);
    if (!parsed.type) {
      issues.push({
        severity: "warning",
        message: `Non-conventional commit: ${c.subject}`,
        hash: c.hash,
      });
    }
  }

  return issues;
}

export async function runSubcommand(argv, cfg) {
  const mode = argv[0];
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  try {
    if (mode === "--scan") {
      const findings = scanStagedSecrets();
      process.stdout.write(JSON.stringify({ findings, count: findings.length }));
      return findings.length ? 2 : 0;
    }
    if (mode === "--release") {
      process.stdout.write(JSON.stringify(buildReleaseInfo()));
      return 0;
    }
    if (mode === "--pr") {
      process.stdout.write(JSON.stringify(await buildPrInfo(opt("--base"), cfg)));
      return 0;
    }
    if (mode === "--split") {
      process.stdout.write(JSON.stringify(await buildSplitPlan(cfg)));
      return 0;
    }
    if (mode === "--review") {
      const { diff } = getStagedDiff();
      if (!diff) {
        process.stdout.write(JSON.stringify({ error: "No staged changes to review" }));
        return 1;
      }
      process.stdout.write(JSON.stringify(await buildReview(diff, cfg)));
      return 0;
    }
    if (mode === "--analytics") {
      const range = opt("--range") || "HEAD~50..HEAD";
      const stats = analyzeCommits(range);
      const badPractices = detectBadPractices(range);
      process.stdout.write(JSON.stringify({ stats, badPractices }));
      return 0;
    }
    process.stdout.write(JSON.stringify({ error: `unknown mode: ${mode}` }));
    return 1;
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e.message }));
    return 1;
  }
}

// ============================================================
//  COMMIT MESSAGE COMPOSITION + MAIN FLOW
// ============================================================

const COAUTHOR_TRAILER = "Co-authored-by: rxdevbot <rxdevbot@users.noreply.github.com>";

export function composeMessage(message, { bumps = [], kind = "patch", addCoauthor = false } = {}) {
  let out = message;
  if (bumps.length) {
    const footer = [`Bump version (${kind}):`, ...bumps.map(([f, o, n]) => `  ${f}: ${o} → ${n}`)];
    out += `\n\n${footer.join("\n")}`;
  }
  if (addCoauthor) out += `\n\n${COAUTHOR_TRAILER}`;
  return out;
}

export function writeErrorToCommit(msgFile, errMsg) {
  try {
    writeFileSync(msgFile, `# RXDev: ${errMsg}\n`, "utf8");
  } catch {}
}

export async function main(commitMsgFile, cfg, opts = {}) {
  const { echo = true } = opts;
  logMessage("\n--- HOOK STARTED ---");

  let existing = "";
  try {
    existing = readFileSync(commitMsgFile, "utf8").trim();
  } catch {}
  if (existing && !existing.startsWith("#")) {
    logMessage("User-provided commit message detected. Skipping AI generation.");
    return 0;
  }

  if (echo) process.stdout.write(`[+] RXDev v${RXDEV_VERSION} started\n`);

  const repoRoot = findRepoRoot();
  if (repoRoot) {
    const conflict = checkConflictingHooks(repoRoot);
    if (conflict) {
      logMessage(`Conflict: ${conflict}`);
      writeErrorToCommit(commitMsgFile, `Conflict detected:\n${conflict}`);
      return 0;
    }
  }

  const { diff, allIgnored } = getStagedDiff();
  if (!diff) {
    if (allIgnored) {
      writeErrorToCommit(commitMsgFile, "All staged files are ignored (listed in .commitignore)");
    } else {
      logMessage("Exit: No staged changes found.");
    }
    return 0;
  }

  const { diff: truncatedDiff, truncated } = truncateDiffSmart(
    diff,
    cfg.maxDiffLength || MAX_DIFF_LENGTH,
  );
  if (truncated) {
    logMessage(`Diff truncated: ${diff.length} chars → ${truncatedDiff.length} chars`);
  }

  const context = gatherContext(repoRoot);
  context.truncated = truncated;

  let message = await generateCommitMessage(truncatedDiff, cfg, { echo, context });
  if (message === null) {
    message = generateFallbackMessage(truncatedDiff);
    logMessage(`Fallback message generated (${message.length} chars)`);
  }

  let bumps = [];
  let kind = "patch";
  if (cfg.bumpVersion && !process.env.RXDEV_SKIP_BUMP && !process.env.NEURO_COMMIT_SKIP_BUMP) {
    kind = determineBumpKind(message);
    bumps = bumpProjectVersion(kind, message, repoRoot);
    if (bumps.length) {
      for (const [f, o, n] of bumps) {
        if (echo) process.stdout.write(`[+] Bumped ${f}: ${o} → ${n} (${kind})\n`);
      }
      // Race-free: stage the bumped manifests so they land in THIS commit.
      // (Does not apply to partial commits, e.g. `git commit <path>`.)
      for (const [rel] of bumps) git(["add", "--", join(repoRoot, rel)], repoRoot);
    }
  }

  message = composeMessage(message, { bumps, kind, addCoauthor: cfg.addCoauthor });

  const dir = dirname(commitMsgFile);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(commitMsgFile, message, "utf8");
  logMessage("Message written to commit file.");
  logMessage("--- HOOK FINISHED ---\n");
  return 0;
}

// ── Script entrypoint (inert when imported, e.g. by tests) ──
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  migrateOldConfig();
  const repoRoot = findRepoRoot();
  const projectConfig = loadProjectConfig(repoRoot);
  const userConfig = { ...loadUserConfig(), ...projectConfig };
  const cfg = resolveConfig(userConfig);
  const arg = process.argv[2];
  if (arg?.startsWith("--")) {
    runSubcommand(process.argv.slice(2), cfg).then((code) => process.exit(code));
  } else {
    const commitMsgFile = arg || ".git/COMMIT_EDITMSG";
    main(commitMsgFile, cfg)
      .then((code) => process.exit(code ?? 0))
      .catch((e) => {
        logMessage(`FATAL: ${e.message}`);
        process.exit(1);
      });
  }
}
