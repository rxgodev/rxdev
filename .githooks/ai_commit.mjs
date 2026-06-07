// neuro-commit — Node port of the prepare-commit-msg hook (WORK IN PROGRESS).
//
// This file is being ported from ai_commit.py slice by slice. It is NOT yet
// wired into prepare-commit-msg — the Python hook (ai_commit.py) remains the
// active hook until this port is complete and fully validated.
//
// Design rule: ZERO external dependencies. The hook is copied standalone into
// each managed repo's .githooks/, so it may only use Node built-ins. The single
// Python dependency (pathspec) is replaced by an inline matcher in a later slice.
//
// Slice 1: the pure logic layer — semver, conventional-commit parsing,
// validation, response cleaning, manifest version handlers, changelog grouping,
// secret scanning, JSON extraction, the fallback generator, provider registry,
// and system-prompt building.
// Slice 2: config/provider resolution, a zero-dependency .commitignore matcher
// (replacing pathspec), staged-diff extraction, and rotating logs.

import {
  readFileSync, existsSync, mkdirSync, appendFileSync, renameSync, statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const NEURO_COMMIT_VERSION = "2.19.3";

export const DEFAULT_GROQ_MODEL = "llama-3.1-8b-instant";

export const DEFAULT_VALID_TYPES = [
  "feat", "fix", "chore", "docs", "style",
  "refactor", "perf", "test", "build", "ci", "revert",
];

// Mutable in later slices (custom types from config); fixed for now.
const validTypes = new Set(DEFAULT_VALID_TYPES);

const PEEK = "__PEEK__";

// ── OpenAI-compatible providers (mirror of PROVIDERS in ai_commit.py) ──
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

// ============================================================
//  SYSTEM PROMPT
// ============================================================

export const BODY_LANGUAGE_PROMPTS = {
  en: "Body: one short WHY sentence in past tense. NO lists, NO file names, NO bullet points.",
  ru: "Body: ОДНО короткое предложение WHY в прошлом времени. БЕЗ списков, БЕЗ имён файлов.",
  de: "Body: EIN kurzer WHY-Satz im Präteritum. KEINE Listen, KEINE Dateinamen, KEINE Aufzählungen.",
  fr: "Body: UNE courte phrase WHY au passé. PAS de listes, PAS de noms de fichiers, PAS de puces.",
  zh: "Body: 一个短句WHY，过去时。不要列表，不要文件名，不要项目符号。",
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
const TYPE_REGEX = new RegExp("^(?:" + TYPE_REGEX_STR + ")", "i");
const COMMIT_RE = new RegExp("^(?:" + TYPE_REGEX_STR + ")(?:\\([^)]*\\))?\\s*:", "i");

export function buildSystemPrompt(typesStr, language, customPrompt = "") {
  if (customPrompt) return customPrompt.replace("{types}", typesStr);
  const bodyPrompt = BODY_LANGUAGE_PROMPTS[language] || BODY_LANGUAGE_PROMPTS.ru;
  return (
    "Format:\ntype(scope): lowercase description\n\none short WHY sentence\n" +
    `Valid types: ${typesStr}.\n` +
    `- ${bodyPrompt}\n` +
    `${BAD_EXAMPLES}`
  );
}

// ============================================================
//  VALIDATION / CLEANING
// ============================================================

export function isValidCommitMessage(msg) {
  if (!msg.trim()) return false;
  const subject = msg.trim().split("\n")[0].trim();
  if (/[а-яА-ЯёЁ]/.test(subject)) return false;

  const m = subject.match(/^([a-z]+)(?:\([^)]*\))?:\s*(.+)$/);
  if (!m) return false;

  const type = m[1];
  const description = m[2];
  if (!validTypes.has(type)) return false;
  if (subject.length > 150) return false;
  if (description.endsWith(".")) return false;
  return true;
}

export function normalizeType(text) {
  const m = text.match(new RegExp("^(" + TYPE_REGEX_STR + ")", "i"));
  if (m) {
    const rest = text.slice(m[0].length).replace(/^[: ]+/, "").trim();
    const sm = rest.match(/^\(([^)]*)\)\s*:\s*(.*)/);
    if (sm) return `${m[1].toLowerCase()}(${sm[1]}): ${sm[2].trim()}`;
    return `${m[1].toLowerCase()}: ${rest}`;
  }
  return text;
}

const SKIP_PREFIXES = [
  "commit message", "response", "output", "result",
  "explanation", "changes", "summary", "diff", "analysis",
  "here is", "here's", "based on", "it appears", "a suitable",
  "the diff shows", "looking at", "in this commit",
];

const STOP_PREFIXES = [
  "however", "alternatively", "if you want", "it's worth noting",
  "the feat", "the fix", "the chore", "the docs", "the style",
  "the refactor", "the test", "the build", "the ci", "the revert",
  "or, if you", "or you could", "note:", "note that",
  "this commit message", "this commit follows",
  "in this case", "the conventional",
  "by the way", "as an alternative",
  "the diff shows", "type(scope)", "type(scope):",
];

export function cleanLlmResponse(text) {
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
      if (COMMIT_RE.test(stripped) || TYPE_REGEX.test(stripped)) {
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
    if (COMMIT_RE.test(stripped)) break;
    bodyParts.push(stripped);
  }

  if (!subject) return "chore: update files";

  subject = normalizeType(subject).replace(/\.+$/, "");
  if (subject.length > 150) subject = subject.slice(0, 147) + "...";

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
    type: null, scope: null, breaking: false,
    description: null, footer_breaking: false,
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
  if (kind === "major") { p.major += 1; p.minor = 0; p.patch = 0; }
  else if (kind === "minor") { p.minor += 1; p.patch = 0; }
  else if (kind === "patch") { p.patch += 1; }
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
    return [JSON.stringify(data, null, 2) + "\n", old];
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
    if (sm) { current = sm[1].trim(); continue; }
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
  return [newVersion + "\n", old];
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
    const full = c.subject + (c.body ? "\n\n" + c.body : "");
    const kind = determineBumpKind(full);
    if (rank[kind] > rank[bump]) bump = kind;
    if (parsed.breaking || parsed.footer_breaking) {
      breaking.push(`${parsed.description || c.subject} (${c.hash})`);
    }
    const t = parsed.type;
    if (SECTION_KEYS.has(t) && parsed.description) {
      (groups[t] ||= []).push({ scope: parsed.scope, desc: parsed.description, hash: c.hash });
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
    if (!items || !items.length) continue;
    lines.push(`### ${title}`);
    for (const it of items) {
      const scope = it.scope ? `**${it.scope}:** ` : "";
      lines.push(`- ${scope}${it.desc} (${it.hash})`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\s+$/, "") + "\n";
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
  ["Hardcoded secret assignment", /(api[_-]?key|secret|token|passwd|password)\s*[=:]\s*['"][^'"]{8,}['"]/i],
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
  t = t.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(t);
  } catch {}
  for (const [open, close] of [["[", "]"], ["{", "}"]]) {
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
  [".js", "feat"], [".ts", "feat"], [".jsx", "feat"], [".tsx", "feat"],
  [".json", "config"], [".toml", "config"], [".yaml", "config"], [".yml", "config"],
  [".md", "docs"], [".css", "style"], [".scss", "style"], [".html", "feat"],
];
const FALLBACK_TYPE_MAP = {
  feat: "feat", fix: "fix", docs: "docs", style: "style",
  refactor: "refactor", test: "test", config: "chore",
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
      const ptype = ["feat", "add", "impl", "new"].some((kw) => lower.includes(kw)) ? "feat" : "refactor";
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
      (a, b) => files.filter((f) => f.includes(b)).length - files.filter((f) => f.includes(a)).length,
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
    (dirChanges[dirName] ||= []).push(posixBasename(f));
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
      if (glob[i] === "!") { cls += "^"; i++; }
      if (glob[i] === "]") { cls += "\\]"; i++; }
      while (i < n && glob[i] !== "]") {
        if (glob[i] === "\\") { cls += "\\" + (glob[i + 1] ?? ""); i += 2; }
        else { cls += glob[i]; i++; }
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
  if (pattern.startsWith("!")) { negate = true; pattern = pattern.slice(1); }
  let dirOnly = false;
  if (pattern.endsWith("/")) { dirOnly = true; pattern = pattern.slice(0, -1); }
  let anchored = false;
  if (pattern.startsWith("/")) { anchored = true; pattern = pattern.slice(1); }
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
      } catch {
        // ignore unparseable pattern rather than break the commit flow
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
    env: "NEURO_COMMIT_API_KEY",
    defaultModel: DEFAULT_GROQ_MODEL,
    needsKey: false, // custom/unknown provider: don't block, let the endpoint decide
  };
  const apiKey =
    userConfig.apiKey ||
    env[providerDef.env] ||
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
const CONFIG_DIR = join(homedir(), ".config", "ai-commit");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const LOG_FILE = join(__dirname, "..", "ai_commit_debug.log");
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
      try { renameSync(LOG_FILE, LOG_FILE + ".1"); } catch {}
    }
    appendFileSync(LOG_FILE, message + "\n", "utf8");
  } catch {
    // logging must never break the commit flow
  }
}

export function git(args, cwd) {
  try {
    const r = spawnSync("git", args, { encoding: "utf8", cwd, maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? (r.stdout || "") : "";
  } catch {
    return "";
  }
}

export function findRepoRoot() {
  const out = git(["rev-parse", "--show-toplevel"]).trim();
  return out || null;
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
        if (matcher.ignores(currentFile)) { currentFile = null; continue; }
        filtered.push("\n# File: " + currentFile);
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
  const stagedFiles = nameOnly.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!stagedFiles.length) return { diff: "", allIgnored: false };

  let patterns = [];
  if (existsSync(".commitignore")) {
    try { patterns = readCommitignore(readFileSync(".commitignore", "utf8")); } catch {}
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
