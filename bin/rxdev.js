#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import updateNotifier from "update-notifier";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SOURCE_GITHOOKS_DIR = join(__dirname, "../.githooks");

const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));

const update = updateNotifier({
  pkg,
  updateCheckInterval: 0,
}).update;

if (update?.latest && update.latest !== pkg.version) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
  const s = (str) => str.replace(/\x1b\[[0-9;]*m/g, "");
  const RED = "\x1b[31m",
    GREEN = "\x1b[32m",
    DIM = "\x1b[38;5;244m",
    RST = "\x1b[0m";

  const lines = [
    `Update available: ${RED}${pkg.version}${RST} → ${GREEN}${update.latest}${RST}`,
    `${DIM}pnpm add -g rxdev@${update.latest}${RST}`,
  ];

  const maxWidth = Math.max(...lines.map((l) => s(l).length)) + 8;
  const top = `   ╭${"─".repeat(maxWidth)}╮`;
  const bottom = `   ╰${"─".repeat(maxWidth)}╯`;
  const pad = `   │${" ".repeat(maxWidth)}│`;

  let out = `\n${top}\n${pad}\n`;
  for (const line of lines) {
    const cl = s(line).length;
    const L = Math.floor((maxWidth - cl) / 2);
    out += `   │${" ".repeat(L)}${line}${" ".repeat(maxWidth - cl - L)}│\n`;
  }
  console.log(`${out}${pad}\n${bottom}\n`);
}

const DEFAULT_COMMITIGNORE = `# Auto-commit configuration files
.githooks/
rxdev.mjs
ai_commit.py
ai_commit_debug.log
.env
.env.local
.commitignore
`;

// === CONFIGURATION ===
const CONFIG_DIR = join(homedir(), ".config", "rxdev");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const MANAGED_PROJECTS_FILE = join(CONFIG_DIR, "managed-projects.json");
const TEMPLATES_FILE = join(CONFIG_DIR, "templates.json");

const DEFAULT_CONFIG = {
  coauthor: true,
  bumpVersion: false,
  language: "ru",
  uiLanguage: "ru",
  commitLanguage: "ru",
  provider: "groq",
};

// OpenAI-compatible providers (mirror of PROVIDERS in rxdev.mjs).
// Keep in sync with .githooks/rxdev.mjs PROVIDERS.
const PROVIDERS = {
  groq: {
    label: "Groq (fast, free tier)",
    env: "GROQ_API_KEY",
    defaultModel: "llama-3.1-8b-instant",
  },
  openai: { label: "OpenAI", env: "OPENAI_API_KEY", defaultModel: "gpt-4o-mini" },
  openrouter: {
    label: "OpenRouter",
    env: "OPENROUTER_API_KEY",
    defaultModel: "openai/gpt-4o-mini",
  },
  ollama: { label: "Ollama (local, no key, private)", env: null, defaultModel: "llama3.1" },
};

const LANGUAGES = {
  en: "English",
  ru: "Русский",
  de: "Deutsch",
  fr: "Français",
  zh: "中文",
};

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
      // migrate old single language field to new separate fields
      if (saved.language && !saved.uiLanguage && !saved.commitLanguage) {
        saved.uiLanguage = saved.language;
        saved.commitLanguage = saved.language;
      }
      return {
        ...DEFAULT_CONFIG,
        ...saved,
      };
    }
  } catch (_e) {
    console.warn("⚠️ Failed to load config, using defaults.");
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

function getManagedProjects() {
  if (!existsSync(MANAGED_PROJECTS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(MANAGED_PROJECTS_FILE, "utf8")).projects || [];
  } catch {
    return [];
  }
}

function registerProject() {
  ensureConfigDir();
  let data = { projects: [] };
  if (existsSync(MANAGED_PROJECTS_FILE)) {
    try {
      data = JSON.parse(readFileSync(MANAGED_PROJECTS_FILE, "utf8"));
    } catch {}
  }
  const projectPath = process.cwd();
  if (!data.projects.includes(projectPath)) {
    data.projects.push(projectPath);
    writeFileSync(MANAGED_PROJECTS_FILE, JSON.stringify(data, null, 2));
  }
}

function unregisterProject(targetPath) {
  if (!existsSync(MANAGED_PROJECTS_FILE)) return;
  try {
    const data = JSON.parse(readFileSync(MANAGED_PROJECTS_FILE, "utf8"));
    const filtered = data.projects.filter((p) => p !== (targetPath || process.cwd()));
    writeFileSync(MANAGED_PROJECTS_FILE, JSON.stringify({ projects: filtered }, null, 2));
  } catch {}
}

function fileHash(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function hashFilePath(pyPath) {
  return `${pyPath}.sha256`;
}

function writePyWithHash(path, content) {
  writeFileSync(path, content);
  writeFileSync(hashFilePath(path), fileHash(content));
}

function getPyVersion(content) {
  // Matches both the Python (`NEURO_COMMIT_VERSION = "x"`) and the Node
  // (`export const NEURO_COMMIT_VERSION = "x"`) hook forms.
  const m = content.match(/NEURO_COMMIT_VERSION\s*=\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}

function semverGt(a, b) {
  // Tolerate prerelease/non-numeric segments (e.g. "19-beta") instead of NaN.
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

function updateProjectHooks(projectPath) {
  const githooksDir = join(projectPath, ".githooks");
  if (!existsSync(githooksDir)) return false;
  let updated = false;

  // Update rxdev.mjs with version/hash check
  const pySrc = join(SOURCE_GITHOOKS_DIR, "rxdev.mjs");
  const pyDst = join(githooksDir, "rxdev.mjs");
  if (existsSync(pySrc)) {
    const latest = readFileSync(pySrc, "utf8");
    if (!existsSync(pyDst)) {
      writePyWithHash(pyDst, latest);
      updated = true;
    } else {
      const hashPath = hashFilePath(pyDst);
      let canUpdate = true;
      if (existsSync(hashPath)) {
        const origHash = readFileSync(hashPath, "utf8").trim();
        const curHash = fileHash(readFileSync(pyDst, "utf8"));
        if (origHash !== curHash) canUpdate = false;
      }
      if (canUpdate) {
        const current = readFileSync(pyDst, "utf8");
        const curVer = getPyVersion(current);
        const latVer = getPyVersion(latest);
        if (!curVer || !latVer) {
          if (current !== latest) {
            writePyWithHash(pyDst, latest);
            updated = true;
          }
        } else if (semverGt(latVer, curVer)) {
          writePyWithHash(pyDst, latest);
          updated = true;
        }
      }
    }
  }

  // Restore prepare-commit-msg if it's broken (missing call to rxdev.mjs)
  const hookSrc = join(SOURCE_GITHOOKS_DIR, "prepare-commit-msg");
  const hookDst = join(githooksDir, "prepare-commit-msg");
  if (existsSync(hookSrc) && existsSync(hookDst)) {
    const installed = readFileSync(hookDst, "utf8");
    if (!installed.includes("rxdev.mjs")) {
      writeFileSync(hookDst, readFileSync(hookSrc, "utf8"));
      if (process.platform !== "win32") {
        spawnSync("chmod", ["+x", hookDst]);
      }
      updated = true;
    }
  }

  return updated;
}

// === UTILS ===

// The commit hook is now pure Node (rxdev.mjs) — no Python/pathspec needed.
// git-filter-repo is only required for `rxdev filter`, which checks for it lazily
// (see checkFilterRepo) and points the user at `pip install git-filter-repo`.

async function installHookForProject(projectPath) {
  const githooksDir = join(projectPath, ".githooks");
  if (!existsSync(githooksDir)) mkdirSync(githooksDir, { recursive: true });

  for (const file of ["rxdev.mjs", "prepare-commit-msg"]) {
    const src = join(SOURCE_GITHOOKS_DIR, file);
    const dst = join(githooksDir, file);
    if (!existsSync(src)) continue;
    const content = readFileSync(src, "utf8");
    if (file === "rxdev.mjs") {
      writePyWithHash(dst, content);
    } else {
      writeFileSync(dst, content);
    }
  }

  if (process.platform !== "win32") {
    spawnSync("chmod", ["+x", join(githooksDir, "prepare-commit-msg")]);
  }

  spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
    stdio: "ignore",
    cwd: projectPath,
  });
}

function setGitHooksPath() {
  if (
    spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
      stdio: "inherit",
    }).status !== 0
  ) {
    console.error("❌ Failed to set git hooks path.");
    process.exit(1);
  }
}

function unsetGitHooksPath() {
  spawnSync("git", ["config", "--unset", "core.hooksPath"], {
    stdio: "ignore",
  });
}

async function askYesNo(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(`${question} (Y/n): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() !== "n");
    });
  });
}

async function promptSelect(options, message) {
  const inquirer = await import("inquirer");
  const choices = options.map((o) =>
    o.value === "__sep__" ? new inquirer.default.Separator() : o,
  );
  const { choice } = await inquirer.default.prompt([
    { type: "list", name: "choice", message, choices, pageSize: 20, loop: false },
  ]);
  return choice;
}

function spawnAsync(cmd, args, options = {}) {
  const { timeout = 30000, ...spawnOpts } = options;
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { ...spawnOpts, stdio: "ignore" });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`spawn ${cmd} timed out after ${timeout}ms`));
    }, timeout);
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

// === TEMPLATES ===

function loadTemplates() {
  if (!existsSync(TEMPLATES_FILE)) return {};
  try {
    return JSON.parse(readFileSync(TEMPLATES_FILE, "utf8"));
  } catch {
    return {};
  }
}

function getTemplateForProject(projectPath) {
  const templates = loadTemplates();
  for (const [name, tpl] of Object.entries(templates)) {
    if (tpl.appliedTo?.includes(projectPath)) {
      return name;
    }
  }
  return null;
}

function saveTemplates(templates) {
  ensureConfigDir();
  writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2));
}

async function askForScript(initial) {
  const inquirer = await import("inquirer");
  const defaultContent = initial || '#!/bin/sh\nnode .githooks/rxdev.mjs "$1"';
  while (true) {
    const { script } = await inquirer.default.prompt([
      {
        type: "editor",
        name: "script",
        message: "Edit full prepare-commit-msg script:",
        default: defaultContent,
      },
    ]);

    const trimmed = script.trim();
    if (!trimmed) return null;

    const error = validatePreCommitScript(trimmed);
    if (error) {
      console.log(`\n❌ Invalid hook: ${error}\nPlease fix and try again.\n`);
    } else {
      return trimmed;
    }
  }
}

function validatePreCommitScript(script) {
  const lines = script
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length === 0) return "Script is empty.";

  const firstLine = lines[0];
  if (!firstLine.startsWith("#!/bin/sh")) {
    return "First line must be: #!/bin/sh";
  }

  const hasCall = lines.some(
    (line) =>
      /node\s+\.githooks\/ai_commit\.mjs\s+"\$1"/.test(line) ||
      line.includes("node .githooks/rxdev.mjs"),
  );

  if (!hasCall) {
    return 'Script must contain: node .githooks/rxdev.mjs "$1"';
  }

  return null;
}

async function applyTemplateToProjects(templateName) {
  const allProjects = getManagedProjects().filter((p) => existsSync(p));
  if (allProjects.length === 0) {
    console.log("📭 No managed projects found.");
    return;
  }

  const inquirer = await import("inquirer");
  const { selected } = await inquirer.default.prompt([
    {
      type: "checkbox",
      name: "selected",
      message: "Select projects to apply template to:",
      choices: [
        ...allProjects.map((p) => ({
          name: `${p.split(/[\\/]/).pop()} → ${p}`,
          value: p,
        })),
      ],
    },
  ]);

  if (selected.length === 0) {
    console.log("↩️  Cancelled.");
    return;
  }

  const templates = loadTemplates();
  const scriptContent = templates[templateName].script;

  for (const proj of selected) {
    const hookDir = join(proj, ".githooks");
    if (!existsSync(hookDir)) mkdirSync(hookDir, { recursive: true });

    const hookPath = join(hookDir, "prepare-commit-msg");
    writeFileSync(hookPath, scriptContent);
    if (process.platform !== "win32") {
      await spawnAsync("chmod", ["+x", hookPath]);
    }

    await spawnAsync("git", ["config", "core.hooksPath", ".githooks"], {
      cwd: proj,
    });
  }

  templates[templateName].appliedTo = [
    ...new Set([...(templates[templateName].appliedTo || []), ...selected]),
  ];
  saveTemplates(templates);

  console.log(`\n✅ Template applied to ${selected.length} project(s).\n`);
}

async function inspectTemplate(name) {
  const templates = loadTemplates();
  const tpl = templates[name];
  const scriptPreview = tpl.script.length > 60 ? `${tpl.script.slice(0, 57)}...` : tpl.script;

  const action = await promptSelect(
    [
      { name: `👁️ View: ${scriptPreview}`, value: "view" },
      { name: "✏️ Edit script", value: "edit" },
      { name: "🚀 Apply to projects", value: "apply" },
      { name: "🗑️ Delete template", value: "delete" },
      { name: "⬅️ Back", value: "back" },
    ],
    `Template: ${name}`,
  );

  if (action === "view") {
    console.log(`\n📜 Script:\n${tpl.script}\n`);
    await askToContinue();
  } else if (action === "edit") {
    const newScript = await askForScript(tpl.script);
    if (newScript !== null) {
      tpl.script = newScript;
      const templates = loadTemplates();
      templates[name] = tpl;
      saveTemplates(templates);
      console.log("✅ Template updated.");

      if (tpl.appliedTo && tpl.appliedTo.length > 0) {
        console.log(`\n🔄 Updating template in ${tpl.appliedTo.length} project(s)...`);
        for (const proj of tpl.appliedTo) {
          if (!existsSync(proj)) {
            console.warn(`⚠️  Skipped missing project: ${proj}`);
            continue;
          }
          const hookDir = join(proj, ".githooks");
          if (!existsSync(hookDir)) mkdirSync(hookDir, { recursive: true });
          const hookPath = join(hookDir, "prepare-commit-msg");
          writeFileSync(hookPath, newScript);
          if (process.platform !== "win32") {
            await spawnAsync("chmod", ["+x", hookPath]);
          }
          await spawnAsync("git", ["config", "core.hooksPath", ".githooks"], {
            cwd: proj,
          });
        }
        console.log("✅ All linked projects updated.\n");
      } else {
        console.log("ℹ️  No projects to update.\n");
      }
    }
  } else if (action === "apply") {
    await applyTemplateToProjects(name);
  } else if (action === "delete") {
    const confirm = await askYesNo(`Delete template "${name}"?`);
    if (confirm) {
      delete templates[name];
      saveTemplates(templates);
      console.log(`✅ Template "${name}" deleted.\n`);
      return; // выйти, чтобы не вернуться в просмотр
    }
  }
}

async function createTemplate() {
  const inquirer = await import("inquirer");
  const { name } = await inquirer.default.prompt([
    { type: "input", name: "name", message: "Template name:" },
  ]);

  if (!name.trim()) return;

  const script = await askForScript("");
  if (script === null) return;

  const templates = loadTemplates();
  templates[name] = { script, appliedTo: [] };
  saveTemplates(templates);
  console.log(`✅ Template "${name}" created.\n`);
}

async function manageTemplates() {
  const aic = await hook();
  while (true) {
    const templates = loadTemplates();
    const templateNames = Object.keys(templates);
    const choices = [
      ...templateNames.map((name) => ({ name, value: name })),
      { name: aic.t("templatesCreateNew"), value: "__new__" },
      { name: aic.t("templatesBack"), value: "__back__" },
    ];

    const selected = await promptSelect(choices, aic.t("templatesTitle"));

    if (selected === "__back__") return;
    if (selected === "__new__") {
      await createTemplate();
    } else {
      await inspectTemplate(selected);
    }
  }
}

async function askToContinue() {
  const inquirer = await import("inquirer");
  await inquirer.default.prompt([
    { type: "input", name: "ok", message: "Press Enter to continue" },
  ]);
}

// === FILE TREE HELPERS ===

function buildFileTree(files, prefix = "  ") {
  const choices = [];

  function addDir(dirPath, subFiles, indent) {
    const subdirs = {};
    const localFiles = [];

    for (const f of subFiles) {
      const idx = f.indexOf("/");
      if (idx === -1) {
        localFiles.push(f);
      } else {
        const sub = f.slice(0, idx);
        if (!subdirs[sub]) subdirs[sub] = [];
        subdirs[sub].push(f.slice(idx + 1));
      }
    }

    for (const name of Object.keys(subdirs).sort()) {
      const fullPath = `${dirPath}/${name}`;
      choices.push({ name: `${indent}📁 ${name}/`, value: `__dir__${fullPath}` });
      addDir(fullPath, subdirs[name], indent + prefix);
    }

    for (const f of localFiles.sort()) {
      choices.push({ name: `${indent}${f}`, value: `${dirPath}/${f}` });
    }
  }

  const topdirs = {};
  const rootFiles = [];

  for (const f of files) {
    const idx = f.indexOf("/");
    if (idx === -1) {
      rootFiles.push(f);
    } else {
      const dir = f.slice(0, idx);
      if (!topdirs[dir]) topdirs[dir] = [];
      topdirs[dir].push(f.slice(idx + 1));
    }
  }

  for (const dir of Object.keys(topdirs).sort()) {
    choices.push({ name: `📁 ${dir}/`, value: `__dir__${dir}` });
    addDir(dir, topdirs[dir], prefix);
  }

  for (const f of rootFiles.sort()) {
    choices.push({ name: f, value: f });
  }

  return choices;
}

function expandDirSelections(selected, allFiles) {
  const expanded = [];
  for (const s of selected) {
    if (s.startsWith("__dir__")) {
      const dir = s.slice(7);
      expanded.push(...allFiles.filter((f) => f === dir || f.startsWith(`${dir}/`)));
    } else {
      expanded.push(s);
    }
  }
  return [...new Set(expanded)];
}

function addBackChoice(choices) {
  return [...choices, { name: "⬅️  Back", value: "__back__" }];
}

async function showFileTreePicker(
  allFiles,
  alreadyStaged,
  message,
  keepDirValues = false,
  allLabel,
) {
  const headerItems = allLabel
    ? [
        { value: "__all__", label: allLabel, isDir: false },
        { value: "__sep__", label: "─".repeat(30), isDir: false },
      ]
    : [];

  const tree = buildFileTree(allFiles);
  const items = [
    ...headerItems,
    ...tree.map((c) => ({
      value: c.value,
      label: c.name,
      isDir: c.value.startsWith("__dir__"),
    })),
  ];

  const dirFiles = {};
  for (const item of items) {
    if (item.isDir) {
      const dirPath = item.value.slice(7);
      dirFiles[item.value] = allFiles.filter((f) => f.startsWith(`${dirPath}/`));
    }
  }

  const checked = new Set();
  for (const item of items) {
    if (
      !item.isDir &&
      item.value !== "__all__" &&
      item.value !== "__sep__" &&
      alreadyStaged.includes(item.value)
    ) {
      checked.add(item.value);
    }
  }

  let cursor = 0;
  let scrollOffset = 0;
  const height = Math.min(20, (process.stdout.rows || 24) - 4);

  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    const origRaw = process.stdin.isRaw || false;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    console.log(`\n${message}\n`);
    let firstRender = true;
    draw();

    function draw() {
      if (!firstRender) {
        const visible = Math.min(height, items.length - scrollOffset);
        for (let i = 0; i < visible + 1; i++) {
          process.stdout.write("\x1b[2K\x1b[1A");
        }
        process.stdout.write("\x1b[2K\r");
      }
      firstRender = false;
      if (cursor < scrollOffset) scrollOffset = cursor;
      if (cursor >= scrollOffset + height) scrollOffset = cursor - height + 1;
      const end = Math.min(scrollOffset + height, items.length);
      for (let i = scrollOffset; i < end; i++) {
        const item = items[i];
        const ptr = i === cursor ? "\x1b[7m❯\x1b[27m" : " ";
        let mark;
        if (item.isDir) {
          const files = dirFiles[item.value] || [];
          const cnt = files.filter((f) => checked.has(f)).length;
          if (cnt === 0) mark = "◻";
          else if (cnt === files.length) mark = "◼";
          else mark = "▣";
        } else {
          mark = checked.has(item.value) ? "◼" : "◻";
        }
        let label = item.label;
        if (!item.isDir && item.value !== "__all__" && item.value !== "__sep__") {
          try {
            const stat = statSync(item.value);
            const size = stat.size < 1024 ? `${stat.size}B` :
                         stat.size < 1024 * 1024 ? `${(stat.size / 1024).toFixed(1)}KB` :
                         `${(stat.size / (1024 * 1024)).toFixed(1)}MB`;
            label = `${item.label} ${"\x1b[2m"}(${size})${"\x1b[22m"}`;
          } catch {}
        }
        process.stdout.write(`${ptr} ${mark} ${label}\n`);
      }
      if (items.length > end)
        process.stdout.write(`  \x1b[2m... ${items.length - end} more\x1b[22m\n`);
      else process.stdout.write("\n");
    }

    function onSubmit() {
      process.stdin.setRawMode(origRaw);
      process.stdin.pause();
      process.stdin.removeAllListeners("keypress");
      const selected = [...checked].filter(
        (v) => !v.startsWith("__dir__") && v !== "__all__" && v !== "__sep__",
      );
      if (keepDirValues) {
        const dirs = items
          .filter((i) => i.isDir && (dirFiles[i.value] || []).every((f) => checked.has(f)))
          .map((i) => i.value);
        resolve([...new Set([...selected, ...dirs])]);
      } else {
        resolve(selected);
      }
    }

    function onKeypress(_str, key) {
      if (!key) return;
      if (key.name === "up" || (key.ctrl && key.name === "p")) {
        if (cursor > 0) cursor--;
        draw();
      } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
        if (cursor < items.length - 1) cursor++;
        draw();
      } else if (key.name === "space") {
        const item = items[cursor];
        if (item.value === "__sep__") {
          draw();
          return;
        }
        if (item.value === "__all__") {
          const allOn = checked.has("__all__");
          if (allOn) {
            checked.clear();
          } else {
            for (const other of items) {
              if (other.value !== "__all__" && other.value !== "__sep__" && !other.isDir) {
                checked.add(other.value);
              }
            }
            checked.add("__all__");
          }
        } else if (item.isDir) {
          const files = dirFiles[item.value] || [];
          if (files.every((f) => checked.has(f))) {
            for (const f of files) checked.delete(f);
          } else {
            for (const f of files) checked.add(f);
          }
        } else {
          if (checked.has(item.value)) checked.delete(item.value);
          else checked.add(item.value);
        }
        draw();
      } else if (key.name === "return" || key.name === "enter") {
        onSubmit();
      } else if (key.name === "escape") {
        process.stdin.setRawMode(origRaw);
        process.stdin.pause();
        process.stdin.removeAllListeners("keypress");
        resolve([]);
      } else if (key.ctrl && key.name === "c") {
        process.exit(0);
      }
    }

    process.stdin.on("keypress", onKeypress);
  });
}

// === CONFIG INTERACTION ===

async function configInteractive() {
  const aic = await hook();
  const config = loadConfig();

  while (true) {
    const provider = config.provider || "groq";
    const modelLabel =
      config.model ||
      (PROVIDERS[provider]?.defaultModel
        ? `${PROVIDERS[provider].defaultModel} (${aic.t("configDefault")})`
        : aic.t("configDefault"));
    const providerLabel = PROVIDERS[provider]?.label || `custom (${config.apiUrl || aic.t("configNoUrl")})`;
    const uiLangLabel = LANGUAGES[config.uiLanguage || config.language] || "Русский";
    const commitLangLabel = LANGUAGES[config.commitLanguage || config.language] || "Русский";

    console.log(`\n⚙️  ${aic.t("configTitle")}\n`);

    const mainAction = await promptSelect(
      [
        { name: aic.t("configSaveExit"), value: "exit" },
        { name: "─".repeat(30), value: "__sep__" },
        {
          name: `${aic.t("configProvider")} ${providerLabel}`,
          value: "provider",
        },
        {
          name: `${aic.t("configModelPre")} ${modelLabel}`,
          value: "model",
        },
        {
          name: `${aic.t("configUiLanguagePre")} ${uiLangLabel}`,
          value: "uiLanguage",
        },
        {
          name: `${aic.t("configCommitLanguagePre")} ${commitLangLabel}`,
          value: "commitLanguage",
        },
        {
          name: `${aic.t("configCustomPromptPre")} ${config.prompt ? aic.t("configSet") : aic.t("configNotSet")}`,
          value: "prompt",
        },
        {
          name: `${aic.t("configCustomTypesPre")} ${config.customTypes?.length ? config.customTypes.join(", ") : aic.t("configNotSet")}`,
          value: "types",
        },
        {
          name: `${aic.t("configApiKeyPre")} ${config.apiKey ? aic.t("configConfigured") : aic.t("configNotSet")}`,
          value: "apikey",
        },
        {
          name: `${aic.t("configCoauthorPre")} ${config.coauthor ? aic.t("configEnabled") : aic.t("configDisabled")}`,
          value: "coauthor",
        },
        {
          name: `${aic.t("configAutoBumpPre")} ${config.bumpVersion ? aic.t("configEnabled") : aic.t("configDisabled")}`,
          value: "bump",
        },
        {
          name: `${aic.t("configTokenLimitsPre")} ${config.tokenLimit ? `${config.tokenLimit.daily || "∞"}/d, ${config.tokenLimit.monthly || "∞"}/m` : aic.t("configNotSet")}`,
          value: "tokenLimits",
        },
        { name: aic.t("configProjectsTemplates"), value: "projects-templates" },
      ],
      aic.t("configSelectSetting"),
    );

    if (mainAction === "exit" || mainAction === "__sep__") return;

    if (mainAction === "coauthor") {
      config.coauthor = !config.coauthor;
      saveConfig(config);
      console.log(config.coauthor ? `✅ ${aic.t("configCoauthorPre")} ${aic.t("configEnabled")}.\n` : `✅ ${aic.t("configCoauthorPre")} ${aic.t("configDisabled")}.\n`);
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (mainAction === "bump") {
      config.bumpVersion = !config.bumpVersion;
      saveConfig(config);
      console.log(config.bumpVersion ? "✅ Auto-bump enabled.\n" : "✅ Auto-bump disabled.\n");
    }

    if (mainAction === "apikey") {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const masked = config.apiKey
        ? `${config.apiKey.slice(0, 8)}...${config.apiKey.slice(-4)}`
        : aic.t("configNotSet");
      const key = await new Promise((resolve) => {
        rl.question(
          `${aic.t("configApiKeyPre")} (current: ${masked})\n   ${aic.t("configSetApiKey")} `,
          resolve,
        );
      });
      rl.close();
      config.apiKey = key.trim();
      saveConfig(config);
      console.log(
        config.apiKey
          ? "✅ API key saved.\n"
          : "ℹ️  API key cleared. Fallback generator will be used.\n",
      );
    }

    if (mainAction === "provider") {
      const inquirer = await import("inquirer");
      const { provider: chosen } = await inquirer.default.prompt([
        {
          type: "list",
          name: "provider",
          message: aic.t("configSetProvider"),
          choices: [
            ...Object.entries(PROVIDERS).map(([value, p]) => ({ name: p.label, value })),
            { name: "Custom (any OpenAI-compatible endpoint)", value: "custom" },
          ],
          default: config.provider || "groq",
        },
      ]);

      if (chosen === "custom") {
        const { apiUrl } = await inquirer.default.prompt([
          {
            type: "input",
            name: "apiUrl",
            message: "Chat-completions URL (…/v1/chat/completions):",
            default: config.apiUrl || "",
          },
        ]);
        config.provider = "custom";
        config.apiUrl = apiUrl.trim();
      } else {
        config.provider = chosen;
        delete config.apiUrl;
      }

      const { model } = await inquirer.default.prompt([
        {
          type: "input",
          name: "model",
          message: `${aic.t("configSetModel")}${PROVIDERS[chosen]?.defaultModel ? ` (${PROVIDERS[chosen].defaultModel})` : ""}:`,
          default: config.model || "",
        },
      ]);
      config.model = model.trim();
      const keyHint =
        chosen === "ollama"
          ? " (no API key needed)"
          : config.apiKey
            ? ""
            : " — remember to set an API key";
      const confirm = await askYesNo(
        `Apply: provider=${config.provider}, model=${config.model || "default"}${keyHint}?`,
      );
      if (confirm) {
        saveConfig(config);
        console.log(`✅ Saved.\n`);
      } else {
        console.log("↩️  Cancelled.\n");
      }
    }

    if (mainAction === "model") {
      const inquirer = await import("inquirer");
      const prov = config.provider || "groq";
      let newModel;
      if (prov === "groq") {
        const { model } = await inquirer.default.prompt([
          {
            type: "list",
            name: "model",
            message: "Select Groq model:",
            choices: [
              { name: "Llama 3.1 8B (faster, 560 t/s)", value: "llama-3.1-8b-instant" },
              { name: "Llama 3.3 70B (smarter, 280 t/s)", value: "llama-3.3-70b-versatile" },
            ],
            default: config.model || "llama-3.1-8b-instant",
          },
        ]);
        newModel = model;
      } else {
        const { model } = await inquirer.default.prompt([
          {
            type: "input",
            name: "model",
            message: `Model name for ${prov} (empty = default${PROVIDERS[prov]?.defaultModel ? `: ${PROVIDERS[prov].defaultModel}` : ""}):`,
            default: config.model || "",
          },
        ]);
        newModel = model.trim();
      }
      const confirm = await askYesNo(`Set model to "${newModel || "default"}"?`);
      if (confirm) {
        config.model = newModel;
        saveConfig(config);
        console.log(`✅ Model: ${config.model || "default"}.\n`);
      } else {
        console.log("↩️  Cancelled.\n");
      }
    }

    if (mainAction === "uiLanguage") {
      const lang = await promptSelect(
        Object.entries(LANGUAGES).map(([code, name]) => ({
          name: `${name} (${code})`,
          value: code,
        })),
        aic.t("configSelectUiLang"),
      );
      const confirm = await askYesNo(`${aic.t("configSetUiLang")} "${LANGUAGES[lang]}"?`);
      if (confirm) {
        config.uiLanguage = lang;
        saveConfig(config);
        aic.setLanguage(lang);
        console.log(`${aic.t("configUiLangUpdated")} ${LANGUAGES[lang]}.\n`);
      } else {
        console.log(`${aic.t("configCancelledArrow")}\n`);
      }
    }

    if (mainAction === "commitLanguage") {
      const lang = await promptSelect(
        Object.entries(LANGUAGES).map(([code, name]) => ({
          name: `${name} (${code})`,
          value: code,
        })),
        aic.t("configSelectCommitLang"),
      );
      const confirm = await askYesNo(`${aic.t("configSetCommitLang")} "${LANGUAGES[lang]}"?`);
      if (confirm) {
        config.commitLanguage = lang;
        saveConfig(config);
        console.log(`${aic.t("configCommitLangUpdated")} ${LANGUAGES[lang]}.\n`);
      } else {
        console.log(`${aic.t("configCancelledArrow")}\n`);
      }
    }

    if (mainAction === "prompt") {
      const inquirer = await import("inquirer");
      const { prompt } = await inquirer.default.prompt([
        {
          type: "editor",
          name: "prompt",
          message: aic.t("configEditPrompt"),
          default: config.prompt || "",
        },
      ]);
      config.prompt = prompt.trim();
      saveConfig(config);
      console.log(
        config.prompt
          ? "✅ Custom prompt saved.\n"
          : "ℹ️  Custom prompt cleared. Default prompt will be used.\n",
      );
    }

    if (mainAction === "types") {
      const inquirer = await import("inquirer");
      const { types } = await inquirer.default.prompt([
        {
          type: "input",
          name: "types",
          message: "Extra commit types (comma-separated, e.g. hotfix, deps, i18n):",
          default: (config.customTypes || []).join(", "),
        },
      ]);
      const parsed = types
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      config.customTypes = parsed;
      saveConfig(config);
      console.log(
        parsed.length ? `✅ Custom types: ${parsed.join(", ")}\n` : "ℹ️  Custom types cleared.\n",
      );
    }

    if (mainAction === "tokenLimits") {
      const limits = config.tokenLimit || {};
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const dailyStr = await new Promise((resolve) => {
        rl.question(`🔋 ${aic.t("configTokenDaily")} (${aic.t("configCurrent")}: ${limits.daily || aic.t("configNotSet")}, ${aic.t("configTokenEmptyKeep")}): `, resolve);
      });
      const monthlyStr = await new Promise((resolve) => {
        rl.question(`🔋 ${aic.t("configTokenMonthly")} (${aic.t("configCurrent")}: ${limits.monthly || aic.t("configNotSet")}, ${aic.t("configTokenEmptyKeep")}): `, resolve);
      });
      rl.close();
      const newLimits = {};
      if (dailyStr.trim()) newLimits.daily = parseInt(dailyStr.trim(), 10);
      if (monthlyStr.trim()) newLimits.monthly = parseInt(monthlyStr.trim(), 10);
      if (Object.keys(newLimits).length) {
        config.tokenLimit = { ...limits, ...newLimits };
        saveConfig(config);
        console.log(`✅ ${aic.t("configTokenLimitsPre")} ${aic.t("configSaved")}\n`);
      } else {
        console.log(`${aic.t("configCancelledArrow")}\n`);
      }
    }

    if (mainAction === "projects-templates") {
      while (true) {
        const allProjects = getManagedProjects();

        const choices = [
          { name: aic.t("projectsBackToMenu"), value: "back" },
          { name: "─".repeat(30), value: "__sep__" },
        ];

        if (allProjects.length === 0) {
          choices.push({ name: aic.t("projectsNoProjects"), value: "__none__" });
        } else {
          for (const p of allProjects) {
            const name = p.split(/[\\/]/).pop();
            const exists = existsSync(p);
            const hasHook = exists && existsSync(join(p, ".githooks"));
            const status = !exists ? aic.t("projectsMissing") : hasHook ? aic.t("projectsActive") : aic.t("projectsHookOff");
            choices.push({ name: `${name} — ${status}`, value: p });
          }
          choices.push({ name: "─".repeat(30), value: "__sep__" });
        }

        choices.push({ name: `🎨 ${aic.t("templatesTitle")}`, value: "templates" });

        const selected = await promptSelect(choices, aic.t("projectsSelect"));

        if (selected === "back" || selected === "__sep__" || selected === "__none__") {
          if (selected === "__none__") {
            console.log(`${aic.t("projectsNoProjectsHint")}\n`);
            await new Promise((r) => setTimeout(r, 1500));
          }
          break;
        }

        if (selected === "templates") {
          await manageTemplates();
          continue;
        }

        const projectPath = selected;
        const projectName = projectPath.split(/[\\/]/).pop();
        const exists = existsSync(projectPath);
        const hasHook = exists && existsSync(join(projectPath, ".githooks"));

        const actions = [
          { name: aic.t("projectsBack"), value: "back" },
          { name: "─".repeat(30), value: "__sep__" },
        ];

        if (exists && hasHook) {
          actions.push({ name: aic.t("projectsDisableHook"), value: "disable" });
        } else if (exists && !hasHook) {
          actions.push({ name: aic.t("projectsEnableHook"), value: "enable" });
        }
        actions.push({ name: aic.t("projectsRemove"), value: "remove" });

        const action = await promptSelect(actions, `${projectName}`);

        if (action === "back" || action === "__sep__") continue;

        if (action === "disable") {
          const confirm = await askYesNo(`${aic.t("projectsDisableConfirm")} ${projectName}?`);
          if (confirm) {
            rmSync(join(projectPath, ".githooks"), { recursive: true, force: true });
            spawnSync("git", ["config", "--unset", "core.hooksPath"], {
              stdio: "ignore",
              cwd: projectPath,
            });
            console.log(`${aic.t("projectsHookDisabled")}\n`);
          }
        } else if (action === "enable") {
          const confirm = await askYesNo(`${aic.t("projectsEnableConfirm")} ${projectName}?`);
          if (confirm) {
            await installHookForProject(projectPath);
            console.log(`${aic.t("projectsHookEnabled")}\n`);
          }
        } else if (action === "remove") {
          const confirm = await askYesNo(`${aic.t("projectsRemoveConfirm")}`);
          if (confirm) {
            unregisterProject(projectPath);
            console.log(`${aic.t("projectsRemoved")}\n`);
          }
        }

        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

// === COMMANDS ===

async function addToGitignore() {
  const gitignorePath = join(process.cwd(), ".gitignore");
  const entry = ".githooks/";

  let content = "";
  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, "utf8");
  }

  if (content.includes(entry)) {
    console.log("ℹ️  .githooks/ already in .gitignore");
    return;
  }

  const shouldAdd = await askYesNo("Add .githooks/ to .gitignore?");
  if (shouldAdd) {
    const newContent = `${content.trimEnd()}\n${entry}\n`;
    writeFileSync(gitignorePath, newContent);
    console.log("✅ Added .githooks/ to .gitignore");
  }
}

async function install() {
  if (!existsSync(join(process.cwd(), ".git"))) {
    console.error("❌ Not a git repo.");
    process.exit(1);
  }

  const githooksDir = join(process.cwd(), ".githooks");
  if (!existsSync(githooksDir)) mkdirSync(githooksDir, { recursive: true });

  for (const file of ["rxdev.mjs", "prepare-commit-msg"]) {
    const src = join(SOURCE_GITHOOKS_DIR, file);
    const dst = join(githooksDir, file);
    if (!existsSync(src)) {
      console.error(`❌ Missing: ${src}`);
      process.exit(1);
    }
    const content = readFileSync(src, "utf8");
    if (file === "rxdev.mjs") {
      writePyWithHash(dst, content);
    } else {
      writeFileSync(dst, content);
    }
  }

  for (const oldFile of [
    "ai_commit.mjs",
    "ai_commit.py",
    "ai_commit.mjs.sha256",
    "ai_commit.py.sha256",
  ]) {
    const oldPath = join(githooksDir, oldFile);
    if (existsSync(oldPath)) {
      try {
        unlinkSync(oldPath);
      } catch {}
    }
  }

  const oldLogFile = join(process.cwd(), "ai_commit_debug.log");
  if (existsSync(oldLogFile)) {
    try {
      unlinkSync(oldLogFile);
    } catch {}
  }

  if (process.platform !== "win32") {
    spawnSync("chmod", ["+x", join(githooksDir, "prepare-commit-msg")]);
  }

  const commitIgnorePath = join(process.cwd(), ".commitignore");
  if (!existsSync(commitIgnorePath)) {
    writeFileSync(commitIgnorePath, DEFAULT_COMMITIGNORE);
  }

  await addToGitignore();

  setGitHooksPath();

  ensureConfigDir();
  if (!existsSync(CONFIG_FILE)) {
    saveConfig(DEFAULT_CONFIG);
  }
  registerProject();

  console.log("🎉 RXDev installed successfully!");
}

function uninstall() {
  unregisterProject();

  const githooks = join(process.cwd(), ".githooks");
  if (existsSync(githooks)) {
    rmSync(githooks, { recursive: true, force: true });
    console.log("✅ Removed .githooks directory");
  }

  unsetGitHooksPath();
  console.log("✅ Git hooks path reset.");
  console.log("🗑️ RXDev uninstalled!");
}

function showStatus() {
  const ok = (s) => `✅ ${s}`;
  const bad = (s) => `❌ ${s}`;
  const warn = (s) => `⚠️  ${s}`;

  // Node version (the hook runtime; >= 18 required)
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  console.log(
    nodeMajor >= 18
      ? ok(`Node: ${process.version}`)
      : bad(`Node ${process.version} is too old — need >= 18`),
  );

  // git-filter-repo (optional, only for `rxdev filter`)
  const fr = spawnSync("git", ["filter-repo", "--version"], { stdio: "pipe" });
  console.log(
    fr.status === 0
      ? ok("Optional: git-filter-repo")
      : warn("git-filter-repo not installed (only needed for 'rxdev filter')"),
  );

  // git repo, hooks path, hook files
  const rootRes = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (rootRes.status !== 0) {
    console.log(bad("Not inside a Git repository.\n"));
    return;
  }
  const gitRoot = rootRes.stdout.trim();

  const hp = spawnSync("git", ["config", "core.hooksPath"], { encoding: "utf8" });
  const hooksPath = hp.status === 0 ? hp.stdout.trim() : "";
  console.log(
    hooksPath === ".githooks"
      ? ok("Hooks path: .githooks")
      : bad(`Hooks path not set — run 'rxdev init' (current: ${hooksPath || "unset"})`),
  );

  const hookFile = join(gitRoot, ".githooks", "prepare-commit-msg");
  console.log(
    existsSync(hookFile)
      ? ok("Hook: prepare-commit-msg present")
      : bad("Hook missing — run 'rxdev init'"),
  );

  const mjsFile = join(gitRoot, ".githooks", "rxdev.mjs");
  if (existsSync(mjsFile)) {
    const hashPath = hashFilePath(mjsFile);
    if (existsSync(hashPath)) {
      const stored = readFileSync(hashPath, "utf8").trim();
      const cur = fileHash(readFileSync(mjsFile, "utf8"));
      console.log(
        stored === cur
          ? ok("Hook: rxdev.mjs integrity OK")
          : warn("rxdev.mjs changed since install (hash mismatch)"),
      );
    } else {
      console.log(warn("rxdev.mjs present but no .sha256 sidecar"));
    }
  } else {
    console.log(bad("rxdev.mjs missing — run 'rxdev init'"));
  }

  const commitignorePath = join(gitRoot, ".commitignore");
  const commitignoreExists = existsSync(commitignorePath);
  console.log(commitignoreExists ? ok(".commitignore: present") : warn(".commitignore: missing"));

  const templateName = getTemplateForProject(gitRoot) || "—";
  const cfg = loadConfig();
  const prov = cfg.provider || "groq";
  const envName = PROVIDERS[prov]?.env;
  const hasKey =
    !!cfg.apiKey || (envName && !!process.env[envName]) || !!process.env.NEURO_COMMIT_API_KEY;

  console.log(`\n🌐 Provider: ${prov}${cfg.model ? ` · ${cfg.model}` : ""}`);
  if (prov === "ollama") {
    console.log(ok("API key: not required (local)"));
  } else {
    console.log(
      hasKey ? ok("API key: configured") : bad(`API key: not set (config or ${envName || "env"})`),
    );
  }
  console.log(`📈 Auto-bump: ${cfg.bumpVersion ? "enabled" : "disabled"}`);
  console.log(`🎨 Template:  ${templateName}`);
  console.log("");
}

// === FILTER-REPO ===

async function checkFilterRepo() {
  const r = spawnSync("git", ["filter-repo", "--version"], { stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) {
    console.error("❌ git-filter-repo not found. Install it:\n");
    console.error("  pip install git-filter-repo\n");
    console.error("  Or run: rxdev init");
    process.exit(1);
  }
  return r.stdout.trim();
}

async function filterHistory() {
  const version = await checkFilterRepo();
  console.log(`\n🔧 git-filter-repo ${version}\n`);

  const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).stdout.trim();
  console.log(`📁 Repository: ${gitRoot}\n`);

  const bold = "\x1b[1m";
  const red = "\x1b[31m";
  const green = "\x1b[32m";
  const reset = "\x1b[0m";
  const dim = "\x1b[38;5;244m";

  const inq = await import("inquirer");

  while (true) {
    const operation = await promptSelect(
      [
        { name: "🗑️  Remove file/folder from history", value: "remove-file" },
        { name: "🔑 Replace text in history (e.g. secret key)", value: "replace-text" },
        { name: "⬅️  Back", value: "back" },
      ],
      "Select operation:",
    );

    if (operation === "back") return;

    const args = ["filter-repo", "--force"];
    let replaceTextFile = null;

    if (operation === "remove-file") {
      const allFiles = spawnSync("git", ["ls-files"], { encoding: "utf8" })
        .stdout.trim()
        .split("\n")
        .filter(Boolean);
      const filePaths = await showFileTreePicker(
        allFiles,
        [],
        "Select files/folders to remove from history:",
        true,
        null,
      );
      if (!filePaths.length) continue;
      const expanded = expandDirSelections(filePaths, allFiles);
      for (const fp of expanded) args.push("--path", fp, "--invert-paths");

      const inqConfirm = await import("inquirer");
      const { addGitignore } = await inqConfirm.default.prompt([
        { type: "confirm", name: "addGitignore", message: "Add to .gitignore?", default: true },
      ]);
      if (addGitignore) {
        const gitignorePath = join(gitRoot, ".gitignore");
        let content = "";
        if (existsSync(gitignorePath)) content = readFileSync(gitignorePath, "utf8");
        const gitignoreEntries = filePaths
          .filter((f) => f.startsWith("__dir__"))
          .map((f) => `${f.slice(7)}/`)
          .concat(filePaths.filter((f) => !f.startsWith("__dir__") && !f.startsWith("__")));
        let added = 0;
        for (const entry of [...new Set(gitignoreEntries)]) {
          if (!content.includes(entry)) {
            content = `${content.trimEnd()}\n${entry}\n`;
            added++;
          }
        }
        writeFileSync(gitignorePath, content);
        if (added > 0) console.log(`✅ Added ${added} entr(ies) to .gitignore`);
      }
    } else if (operation === "replace-text") {
      const { search, replace } = await inq.default.prompt([
        { type: "input", name: "search", message: "Text to find:" },
        { type: "input", name: "replace", message: "Replace with:" },
      ]);
      if (!search.trim()) continue;
      // git-filter-repo --replace-text expects a FILE of expressions, not an inline string.
      // Format: `literal:SEARCH==>REPLACEMENT` (omit `==>` to default to ***REMOVED***).
      const s = search.trim();
      const r = replace.trim();
      const expr = r ? `literal:${s}==>${r}` : `literal:${s}`;
      replaceTextFile = join(tmpdir(), `rxcommit-replace-${randomBytes(8).toString("hex")}.txt`);
      writeFileSync(replaceTextFile, `${expr}\n`);
      args.push("--replace-text", replaceTextFile);
    }

    const cleanupTmp = () => {
      if (replaceTextFile) {
        try {
          unlinkSync(replaceTextFile);
        } catch {}
      }
    };

    console.log(`\n${red}${bold}⚠️  WARNING: This will REWRITE git history!${reset}`);
    console.log(
      `${dim}This is destructive and irreversible. Command: git ${args.join(" ")}${reset}\n`,
    );

    const repoName = gitRoot.split(/[\\/]/).filter(Boolean).pop() || "repo";

    // 1) Safety backup — a bundle captures ALL refs and can fully restore the repo.
    const { backup } = await inq.default.prompt([
      {
        type: "confirm",
        name: "backup",
        message: "Create a safety backup bundle first? (recommended)",
        default: true,
      },
    ]);
    if (backup) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const bundlePath = join(dirname(gitRoot), `${repoName}-backup-${stamp}.bundle`);
      console.log(`\n💾 Backing up to ${bundlePath} ...`);
      const b = spawnSync("git", ["bundle", "create", bundlePath, "--all"], {
        stdio: "inherit",
        cwd: gitRoot,
      });
      if (b.status !== 0) {
        console.error("\n❌ Backup failed — aborting. No history was rewritten.");
        cleanupTmp();
        process.exit(1);
      }
      console.log(
        `${green}✅ Backup created.${reset} ${dim}Restore with: git clone "${bundlePath}" <dir>${reset}\n`,
      );
    }

    // 2) Typed confirmation — must type the repo name (GitHub-style guard).
    const { typed } = await inq.default.prompt([
      {
        type: "input",
        name: "typed",
        message: `Type the repository name "${repoName}" to confirm (empty cancels):`,
      },
    ]);
    if (typed.trim() !== repoName) {
      console.log("↩️  Name did not match — cancelled. No history was rewritten.\n");
      cleanupTmp();
      continue;
    }

    console.log(`\n🔄 Rewriting history...\n`);
    const result = spawnSync("git", args, { stdio: "inherit" });
    if (replaceTextFile) {
      try {
        unlinkSync(replaceTextFile);
      } catch {}
    }
    if (result.status !== 0) {
      console.error("\n❌ History rewrite failed.");
      process.exit(1);
    }
    console.log(`\n${green}✅ History rewritten successfully.${reset}`);
    console.log(`${dim}Use 'git push --force --all' to update remote.${reset}\n`);
    break;
  }
}

// === HELP & VERSION ===

const boldCyan = "\x1b[1m\x1b[38;2;57;186;229m";
const resetColor = "\x1b[0m";

async function quickFlow() {
  const aic = await hook();
  const bold = "\x1b[1m";
  const dim = "\x1b[38;5;244m";
  const reset = "\x1b[0m";
  const green = "\x1b[32m";
  const cyan = "\x1b[36m";
  const yellow = "\x1b[33m";

  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
  const sa = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

  const clearScreen = () => process.stdout.write("\x1b[2J\x1b[H");

  // ── Header box (only boxed element) ──
  const showHeader = () => {
    clearScreen();
    const lines = [`${bold}${aic.t("goTitle")}${reset}`];
    const w = Math.max(...lines.map((l) => sa(l).length)) + 4;
    const o =
      "╭" +
      "─".repeat(w) +
      "╮\n" +
      "│" +
      " ".repeat(w) +
      "│\n" +
      "│" +
      " ".repeat(Math.floor((w - sa(lines[0]).length) / 2)) +
      lines[0] +
      " ".repeat(w - sa(lines[0]).length - Math.floor((w - sa(lines[0]).length) / 2)) +
      "│\n" +
      "│" +
      " ".repeat(w) +
      "│\n" +
      "╰" +
      "─".repeat(w) +
      "╯\n";
    process.stdout.write(o);
  };

  // ── Pretty section separator ──
  const sep = (title) => {
    const tw = sa(title).length;
    const cols = Math.min(process.stdout.columns || 80, 72);
    const dash = Math.max(cols - tw - 2, 4);
    return `${title}  ${cyan}${"─".repeat(dash)}${reset}`;
  };

  // ================================================================
  //  STEP 1 — Stage
  // ================================================================
  showHeader();

  console.log(`\n${sep(`${bold}${aic.t("goStageTitle")}${reset}`)}\n`);

  const unstaged = spawnSync("git", ["diff", "--name-only"], { encoding: "utf8" })
    .stdout.trim()
    .split("\n")
    .filter(Boolean)
    .filter((f) => {
      try {
        return existsSync(join(process.cwd(), f));
      } catch {
        return false;
      }
    });
  const alreadyStaged = spawnSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8" })
    .stdout.trim()
    .split("\n")
    .filter(Boolean)
    .filter((f) => {
      try {
        return existsSync(join(process.cwd(), f));
      } catch {
        return false;
      }
    });
  const allChanged = [...new Set([...unstaged, ...alreadyStaged])];

  if (allChanged.length === 0) {
    console.log(`${aic.t("goNoChangedFiles")}\n`);
  }

  let filesToStage = [];

  if (allChanged.length > 0) {
    const selected = await showFileTreePicker(
      allChanged,
      alreadyStaged,
      aic.t("goStageTitle"),
      false,
      `${aic.t("goStageTitle")}`,
    );

    if (selected.length === 0) return;

    const hasAll = selected.some((v) => v === "__all__");
    if (hasAll) {
      filesToStage = allChanged;
    } else {
      filesToStage = selected;
    }
  }

  if (filesToStage.length > 0) {
    const addResult = spawnSync("git", ["add", "--", ...filesToStage], { stdio: "pipe" });
    if (addResult.status !== 0) {
      console.error(`${aic.t("goStageFailed")} ${addResult.stderr || "unknown error"}`);
      process.exit(1);
    }
    console.log(`${green}${aic.t("goStaged")}${reset}\n`);
  }

  // ── Secret scan before committing ──
  const secrets = await scanSecrets();
  if (secrets.length > 0) {
    console.log(`${yellow}${aic.t("goSecretsFound")} ${secrets.length}:${reset}`);
    for (const f of secrets) console.log(`   • ${f.type} — ${f.file} (${f.preview})`);
    console.log("");
    const action = await promptSelect(
      [
        { name: `⚠️   ${aic.t("scanCommitAnyway")}`, value: "commit" },
        { name: `🗑️   ${aic.t("scanUnstage")}`, value: "unstage" },
        { name: `❌   ${aic.t("scanCancel")}`, value: "cancel" },
      ],
      aic.t("scanWhatToDo"),
    );
    if (action === "cancel") {
      console.log(`\n${bold}${aic.t("scanCancel")}${reset}`);
      return;
    }
    if (action === "unstage") {
      const secretFiles = [...new Set(secrets.map((s) => s.file))];
      spawnSync("git", ["reset", "HEAD", "--", ...secretFiles], { stdio: "pipe" });
      console.log(`${yellow}${aic.t("scanUnstaged")} ${secretFiles.join(", ")}${reset}\n`);
    }
  }

  // ================================================================
  //  STEP 2 — Generate
  // ================================================================
  showHeader();

  console.log(`\n${sep(`${bold}${aic.t("goGeneratingCommit")}${reset}`)}\n`);
  console.log(`${dim}${aic.t("goAiAnalyzing")}${reset}\n`);

  const makeCommit = (skipBump) =>
    new Promise((resolve) => {
      const child = spawn("git", ["commit", "--quiet"], {
        stdio: ["inherit", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_EDITOR: "true",
          ...(skipBump ? { NEURO_COMMIT_SKIP_BUMP: "1" } : {}),
        },
        detached: true,
      });

      let cancelled = false;
      const onSig = () => {
        cancelled = true;
        try {
          if (process.platform === "win32") {
            spawnSync("taskkill", ["/f", "/t", "/pid", String(child.pid)], { stdio: "ignore" });
          } else {
            child.kill("SIGTERM");
          }
        } catch {}
      };
      process.on("SIGINT", onSig);

      child.stdout.on("data", (d) => {
        process.stdout.write(d.toString());
      });

      child.stderr.on("data", (d) => {
        if (!cancelled) process.stderr.write(d);
      });

      child.on("close", (code) => {
        process.removeListener("SIGINT", onSig);
        resolve(cancelled ? null : code);
      });
    });

  const commitCode = await makeCommit();
  console.log("");
  if (commitCode === null) {
    process.exit(130);
  }
  if (commitCode !== 0) {
    const commitMsgFile = join(process.cwd(), ".git", "COMMIT_EDITMSG");
    try {
      const raw = readFileSync(commitMsgFile, "utf8");
      const userLines = raw.split("\n").filter((l) => {
        const t = l.trim();
        return (
          t &&
          !t.startsWith("# On ") &&
          !t.startsWith("# Please") &&
          !t.startsWith("# It looks") &&
          !t.startsWith("# Your branch") &&
          !t.startsWith("# Changes") &&
          !t.startsWith("# Untracked") &&
          !t.startsWith("#")
        );
      });
      if (userLines.length > 0) {
        console.log(`\n${userLines.join("\n")}\n`);
      }
    } catch {}
    console.error(aic.t("goFailedCommit"));
    process.exit(1);
  }

  const commitMsgFile = join(process.cwd(), ".git", "COMMIT_EDITMSG");
  let currentMessage = readFileSync(commitMsgFile, "utf8")
    .trim()
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n")
    .trim();

  if (!currentMessage) {
    console.error(aic.t("goFailedCommit"));
    process.exit(1);
  }

  // ================================================================
  //  REVIEW LOOP
  // ================================================================

  const showReview = () => {
    clearScreen();
    showHeader();
    console.log(`\n${sep(`${bold}${aic.t("goReview")}${reset}`)}\n`);

    const raw = currentMessage.trimEnd().split("\n");
    const innerW = Math.min(process.stdout.columns || 80, 72) - 4;
    const wrapped = [];
    for (const line of raw) {
      if (sa(line).length > innerW && innerW > 20) {
        for (let i = 0; i < line.length; i += innerW) wrapped.push(line.slice(i, i + innerW));
      } else wrapped.push(line);
    }
    for (const l of wrapped) console.log(l);
    console.log("");
  };

  showReview();
  const commitTokStats = aic.getTokenStats();
  const wasFallback = currentMessage.includes(aic.t("tokensLimitExceeded"));
  if (wasFallback) {
    console.log(`\n\x1b[33m⚠️  ${aic.t("tokensLimitExceeded")}\x1b[0m\n`);
  } else if (commitTokStats.lastRequest) {
    const limits = loadConfig().tokenLimit || {};
    let pct = "";
    if (limits.daily && commitTokStats.lastRequest) {
      const reqPct = Math.round((commitTokStats.lastRequest / limits.daily) * 10000) / 100;
      const remainPct = Math.round((Math.max(0, limits.daily - commitTokStats.daily) / limits.daily) * 10000) / 100;
      pct = ` (${reqPct}% ${aic.t("tokensOfDaily")}, ${remainPct}% ${aic.t("tokensLeft")})`;
    }
    console.log(`\n\x1b[38;5;244m⚡ ${commitTokStats.lastRequest}${aic.t("tokensUnit")}${pct}\x1b[0m\n`);
  }

  while (true) {
    const action = await promptSelect(
      [
        { name: `${green}✅  ${aic.t("goPush")}${reset}`, value: "push" },
        { name: `${cyan}✏️   ${aic.t("goEdit")}${reset}`, value: "edit" },
        { name: `${yellow}🔄  ${aic.t("goRegenerate")}${reset}`, value: "regenerate" },
        { name: `${bold}❌  ${aic.t("goCancel")}${reset}`, value: "cancel" },
      ],
      `❓ ${aic.t("goTitle")}`,
    );

    if (action === "push") break;
    if (action === "cancel") {
      spawnSync("git", ["reset", "--soft", "HEAD~1"], { stdio: "pipe" });
      console.log(`\n${bold}${aic.t("goCommitCancelled")}${reset}`);
      return;
    }

    if (action === "edit") {
      writeFileSync(commitMsgFile, currentMessage, "utf8");
      const defaultEditor = process.platform === "win32" ? "notepad" : "vi";
      const editor =
        process.env.GIT_EDITOR || process.env.VISUAL || process.env.EDITOR || defaultEditor;
      const editRes = spawnSync(editor, [commitMsgFile], { stdio: "inherit", shell: false });
      if (editRes.status !== 0) {
        console.log(`\n${yellow}↩️  Edit cancelled${reset}`);
        continue;
      }
      const edited = readFileSync(commitMsgFile, "utf8")
        .trim()
        .split("\n")
        .filter((l) => !l.trim().startsWith("#"))
        .join("\n")
        .trim();
      if (!edited) {
        console.log(`\n${yellow}❌ Empty message${reset}`);
        continue;
      }
      writeFileSync(commitMsgFile, edited, "utf8");
      const amend = spawnSync("git", ["commit", "--amend", "-F", commitMsgFile], {
        stdio: "inherit",
        env: { ...process.env, GIT_EDITOR: "true" },
      });
      if (amend.status !== 0) {
        console.error("❌ Amend failed");
        process.exit(1);
      }
      currentMessage = edited;
      showReview();
    }

    if (action === "regenerate") {
      spawnSync("git", ["reset", "--soft", "HEAD~1"], { stdio: "pipe" });
      showHeader();
      console.log(`\n${sep(`${bold}${aic.t("goGeneratingCommit")}${reset}`)}\n`);
      console.log(`${dim}${aic.t("goAiAnalyzing")}${reset}\n`);
      const c = await makeCommit(true);
      console.log("");
      if (c === null) {
        process.exit(130);
      }
      if (c !== 0) {
        console.error(aic.t("goFailedCommit"));
        process.exit(1);
      }
      currentMessage = readFileSync(commitMsgFile, "utf8")
        .trim()
        .split("\n")
        .filter((l) => !l.trim().startsWith("#"))
        .join("\n")
        .trim();
      if (!currentMessage) {
        console.error(aic.t("goFailedCommit"));
        process.exit(1);
      }
      showReview();
    }
  }

  // ================================================================
  //  STEP 3 — Push
  // ================================================================
  showHeader();

  console.log(`\n${sep(`${bold}${aic.t("goPushTitle")}${reset}`)}\n`);

  const remotes = spawnSync("git", ["remote"], { encoding: "utf8" })
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const allBranches = spawnSync("git", ["branch", "--format=%(refname:short)"], {
    encoding: "utf8",
  })
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const _currentBranch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();

  const remoteChoices = addBackChoice(
    remotes.length
      ? remotes.map((r) => ({ name: r, value: r }))
      : [{ name: "origin", value: "origin" }],
  );
  const remote = await promptSelect(remoteChoices, "Select remote:");
  if (remote === "__back__") return;

  const branchChoices = addBackChoice(
    allBranches.length
      ? allBranches.map((b) => ({ name: b, value: b }))
      : [{ name: "main", value: "main" }],
  );
  const branch = await promptSelect(branchChoices, "Select branch:");
  if (branch === "__back__") return;

  console.log(`\n${aic.t("goPushing")} ${remote}/${branch}...`);
  const push = spawnSync("git", ["push", remote, branch], { stdio: "inherit" });
  if (push.status !== 0) {
    console.error(`\n❌ ${aic.t("goFailedCommit")}`);
    process.exit(1);
  }
  console.log(`${green}${aic.t("goPushed")}${reset}\n`);
}

// === SCAN / RELEASE / PR / SPLIT (in-process via the Node hook module) ===

let _hookModule = null;
async function hook() {
  if (!_hookModule) {
    const hookPath = pathToFileURL(join(SOURCE_GITHOOKS_DIR, "rxdev.mjs")).href;
    _hookModule = await import(hookPath);
  }
  return _hookModule;
}
function hookConfig(aic) {
  const userConfig = aic.loadUserConfig();
  const projectConfig = aic.loadProjectConfig(process.cwd());
  return aic.resolveConfig({ ...userConfig, ...projectConfig });
}

async function scanSecrets() {
  const aic = await hook();
  return aic.scanStagedSecrets();
}

async function scanCommand() {
  const aic = await hook();
  const findings = await scanSecrets();
  if (!findings.length) {
    console.log(`\n✅ ${aic.t("scanClean")}\n`);
    return;
  }
  console.log(`\n🚨 ${findings.length} ${aic.t("scanFound")}\n`);
  for (const f of findings) {
    console.log(`  • ${f.type} — ${f.file}  (${f.preview})`);
  }
}

async function releaseCommand() {
  const aic = await hook();
  const data = aic.buildReleaseInfo();
  if (!data || data.error) {
    console.error(`\n❌ ${data?.error || aic.t("error")}`);
    process.exit(1);
  }

  console.log(`\n${aic.t("releaseTitle")}\n`);
  console.log(`   ${aic.t("releaseSince")}  ${data.from || "(no tags — summarizing all history)"}`);
  console.log(`   ${aic.t("releaseCurrent")} ${data.current}`);
  console.log(`   ${aic.t("releaseBump")}    ${data.bump}  →  ${data.next}`);
  console.log(`   ${aic.t("releaseCommits")} ${data.count}\n`);
  console.log(`──────── ${aic.t("releaseNotes")} ────────\n`);
  console.log(data.changelog);
  console.log("─────────────────────────────────\n");

  if (data.count === 0) {
    console.log(`${aic.t("releaseNothing")}\n`);
    return;
  }

  const tag = `v${data.next}`;
  const proceed = await askYesNo(`${aic.t("releaseCreateTag")}`);
  if (!proceed) {
    console.log(`${aic.t("configCancelledArrow")}\n`);
    return;
  }

  const tagRes = spawnSync("git", ["tag", "-a", tag, "-m", tag], { stdio: "inherit" });
  if (tagRes.status !== 0) {
    console.error(`${aic.t("releaseTagFailed")} ${tag}`);
    process.exit(1);
  }
  console.log(`${aic.t("releaseTagCreated")} ${tag}`);

  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  spawnSync("git", ["push", "origin", branch], { stdio: "inherit" });
  spawnSync("git", ["push", "origin", tag], { stdio: "inherit" });
  console.log(`${aic.t("goPushed")}`);

  const hasGh = spawnSync("gh", ["--version"], { stdio: "pipe" }).status === 0;
  if (hasGh) {
    const notesFile = join(tmpdir(), `rxdev-release-${randomBytes(8).toString("hex")}.md`);
    writeFileSync(notesFile, data.changelog);
    const ghRes = spawnSync(
      "gh",
      ["release", "create", tag, "--title", tag, "--notes-file", notesFile],
      {
        stdio: "inherit",
      },
    );
    try {
      unlinkSync(notesFile);
    } catch {}
    if (ghRes.status === 0) {
      console.log(`${aic.t("releaseCreated")}\n`);
    } else {
      console.log(
        `⚠️  Failed to create GitHub Release. Create manually:\n   gh release create ${tag}\n`,
      );
    }
  } else {
    console.log(
      `${aic.t("releaseInstallGh")}\n   gh release create ${tag}\n`,
    );
  }
}

async function prCommand(baseArg) {
  const base = baseArg || null;
  const aic = await hook();
  console.log(`\n${aic.t("prGenerating")}\n`);
  const data = await aic.buildPrInfo(base, hookConfig(aic));
  if (!data || data.error) {
    console.error(`\n❌ ${data?.error || aic.t("error")}`);
    process.exit(1);
  }
  console.log(`${aic.t("prTitle")} ${data.title}\n`);
  console.log(data.body);
  console.log("");

  const hasGh = spawnSync("gh", ["--version"], { stdio: "pipe" }).status === 0;
  if (hasGh) {
    const create = await askYesNo(`${aic.t("prCreate")} ${data.base})?`);
    if (create) {
      const tmp = join(tmpdir(), `rxcommit-pr-${randomBytes(8).toString("hex")}.md`);
      writeFileSync(tmp, data.body);
      const r = spawnSync(
        "gh",
        ["pr", "create", "--base", data.base, "--title", data.title, "--body-file", tmp],
        { stdio: "inherit" },
      );
      try {
        unlinkSync(tmp);
      } catch {}
      if (r.status !== 0) console.error(`❌ ${aic.t("prTitle")} gh pr create failed.`);
    }
  } else {
    console.log(`${aic.t("prInstallGh")}\n`);
  }
}

async function splitCommand() {
  const aic = await hook();
  console.log(`\n${aic.t("splitTitle")}\n`);
  const data = await aic.buildSplitPlan(hookConfig(aic));
  if (!data || data.error) {
    console.error(`\n❌ ${data?.error || aic.t("error")}`);
    process.exit(1);
  }
  const groups = data.groups || [];
  if (!groups.length) {
    console.log(`${aic.t("splitNoPlan")}\n`);
    return;
  }

  console.log(`${aic.t("splitProposed")} ${groups.length}:\n`);
  groups.forEach((g, i) => {
    console.log(`  ${i + 1}. ${g.message}`);
    if (g.reason) console.log(`      ↳ ${g.reason}`);
    for (const f of g.files) {
      console.log(`        - ${f}`);
    }
    console.log("");
  });
  if (data.unassigned?.length) {
    console.log(`${aic.t("splitLeftStaged")} ${data.unassigned.join(", ")}\n`);
  }

  const apply = await askYesNo(aic.t("splitApply"));
  if (!apply) {
    console.log(`${aic.t("splitCancelled")}\n`);
    return;
  }

  const staged = data.staged || [];
  const reStageAll = () => spawnSync("git", ["add", "--", ...staged], { stdio: "pipe" });
  for (const g of groups) {
    spawnSync("git", ["reset", "-q", "--", ...staged], { stdio: "pipe" });
    const addRes = spawnSync("git", ["add", "--", ...g.files], { stdio: "pipe" });
    if (addRes.status !== 0) {
      console.error(`❌ ${aic.t("error")} Failed to stage a group — aborting and restoring staging.`);
      reStageAll();
      process.exit(1);
    }
    const c = spawnSync("git", ["commit", "-m", g.message], {
      stdio: "inherit",
      env: { ...process.env, NEURO_COMMIT_SKIP_BUMP: "1", GIT_EDITOR: "true" },
    });
    if (c.status !== 0) {
      console.error(`❌ ${aic.t("error")} A commit failed — aborting and restoring staging.`);
      reStageAll();
      process.exit(1);
    }
    console.log(`✅ ${g.message}`);
  }
  if (data.unassigned?.length) {
    spawnSync("git", ["add", "--", ...data.unassigned], { stdio: "pipe" });
  }
  console.log(`\n${aic.t("splitCreated")}\n`);
}

function levenshteinDistance(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[b.length];
}

function suggestCommand(input) {
  const commands = ["config", "filter", "go", "init", "pr", "release", "review", "scan", "split", "stats", "status", "tokens", "uninstall", "update", "version"];
  let bestMatch = null;
  let bestDistance = Infinity;
  for (const cmd of commands) {
    const dist = levenshteinDistance(input.toLowerCase(), cmd);
    if (dist < bestDistance && dist <= 2) {
      bestDistance = dist;
      bestMatch = cmd;
    }
  }
  return bestMatch;
}

function stripMarkdown(text) {
  return text
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "  • ")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .trim();
}

async function reviewCommand() {
  const aic = await hook();
  const { diff } = await aic.getStagedDiff();
  if (!diff) {
    console.log(`ℹ️  ${aic.t("reviewNoChanges")}\n`);
    return;
  }
  const cfg = hookConfig(aic);
  if (!cfg.apiKey && cfg.needsKey) {
    console.error(`❌ ${aic.t("reviewNoApiKey")}\n`);
    process.exit(1);
  }
  const data = await aic.buildReview(diff, cfg);
  if (!data || data.error) {
    console.error(`\n❌ ${data?.error || aic.t("reviewFailed")}`);
    process.exit(1);
  }
  console.log(`\n🔍 ${aic.t("reviewTitle")}\n`);
  console.log(stripMarkdown(data.review));
  if (data.issueCount > 0) {
    console.log(`\n${"─".repeat(40)}`);
    console.log(`📋 ${data.issueCount} ${aic.t("reviewIssues")}`);
  }
  const tokStats = aic.getTokenStats();
  if (tokStats.lastRequest) {
    const limits = cfg.tokenLimit || {};
    let pct = "";
    if (limits.daily && tokStats.lastRequest) {
      const reqPct = Math.round((tokStats.lastRequest / limits.daily) * 10000) / 100;
      const remainPct = Math.round((Math.max(0, limits.daily - tokStats.daily) / limits.daily) * 10000) / 100;
      pct = ` (${reqPct}% ${aic.t("tokensOfDaily")}, ${remainPct}% ${aic.t("tokensLeft")})`;
    }
    console.log(`\n\x1b[38;5;244m⚡ ${tokStats.lastRequest}${aic.t("tokensUnit")}${pct}\x1b[0m`);
  }
  console.log("");
}

async function statsCommand() {
  const aic = await hook();
  const repoName = process.cwd().split(/[\\/]/).pop();
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  console.log(`\n📊 ${repoName}:${branch} — ${aic.t("statsTitle")}\n`);
  const rangeIdx = args.indexOf("--range");
  const range = rangeIdx !== -1 ? args[rangeIdx + 1] : "HEAD~20..HEAD";

  let data;
  try {
    data = aic.analyzeCommits(range);
  } catch (e) {
    console.error(`❌ Error analyzing commits: ${e.message}`);
    process.exit(1);
  }

  let badPractices = [];
  try {
    badPractices = aic.detectBadPractices(range);
  } catch {
    // Ignore bad practices errors
  }

  if (data.total === 0) {
    console.log(`ℹ️  ${aic.t("statsNoCommits")}\n`);
    return;
  }

  console.log(`${aic.t("statsTotal")} ${data.total}`);
  console.log(`${aic.t("statsAvgLen")} ${data.avgMessageLength} ${aic.t("statsChars")}`);
  console.log(`${aic.t("statsBreaking")} ${data.breakingChanges}`);
  console.log(`\n${aic.t("statsByType")}`);
  for (const [type, count] of Object.entries(data.byType)) {
    console.log(`  ${type}: ${count}`);
  }
  if (badPractices.length > 0) {
    console.log(`\n⚠️  ${aic.t("statsBadPractices")} ${badPractices.length}`);
    for (const issue of badPractices.slice(0, 5)) {
      console.log(`  - ${issue.message}`);
    }
  }
}

function showHelp(tr) {
  const _ = tr || ((s) => s);
  console.log(`${boldCyan}RXDev${resetColor} ${_("helpTagline")} ${"\x1b[38;5;244m"}(v${pkg.version})${resetColor}

${"\x1b[1m\x1b[37m"}${_("helpUsage")}${resetColor}
  ${boldCyan}rxdev${resetColor} ${_("helpCmdPlaceholder")} ${_("helpOptsPlaceholder")}

${"\x1b[1m\x1b[37m"}${_("helpCommands")}${resetColor}
  ${boldCyan}config${resetColor}        ${_("helpDescConfig")}
  ${boldCyan}filter${resetColor}        ${_("helpDescFilter")}
  ${boldCyan}go${resetColor}            ${_("helpDescGo")}
  ${boldCyan}init${resetColor}          ${_("helpDescInit")}
  ${boldCyan}pr${resetColor}            ${_("helpDescPr")}
  ${boldCyan}release${resetColor}       ${_("helpDescRelease")}
  ${boldCyan}review${resetColor}        ${_("helpDescReview")}
  ${boldCyan}scan${resetColor}          ${_("helpDescScan")}
  ${boldCyan}split${resetColor}         ${_("helpDescSplit")}
  ${boldCyan}stats${resetColor}         ${_("helpDescStats")}
  ${boldCyan}status${resetColor}        ${_("helpDescStatus")}
  ${boldCyan}tokens${resetColor}        ${_("helpDescTokens")}
  ${boldCyan}uninstall${resetColor}     ${_("helpDescUninstall")}
  ${boldCyan}update${resetColor}        ${_("helpDescUpdate")}
  ${boldCyan}version${resetColor}       ${_("helpDescVersion")}`);
}

const args = process.argv.slice(2);

const filteredArgs = args;
const cmd = filteredArgs[0];

// Handle global flags first
if (filteredArgs.includes("--version") || filteredArgs.includes("-v") || cmd === "version") {
  console.log(`v${pkg.version}`);
  process.exit(0);
}

if (filteredArgs.includes("--help") || filteredArgs.includes("-h")) {
  // help goes through mainCmd's default case
}

// === AUTO-UPDATE MANAGED PROJECTS' HOOKS ===
// Only on an explicit `rxdev update`. Previously this ran on almost every command,
// silently rewriting the hooks of OTHER managed repos whenever the user ran rxdev
// anywhere — surprising and, across a runtime switch, actively harmful.
if (cmd === "update") {
  const projects = getManagedProjects().filter((p) => existsSync(p));
  let updatedCount = 0;
  for (const proj of projects) {
    if (updateProjectHooks(proj)) updatedCount++;
  }
  if (updatedCount > 0) {
    console.log(`\n🔄 Updated AI hooks in ${updatedCount} project(s).\n`);
  }
}

// === COMMANDS ===
async function tokensCommand() {
  const aic = await hook();
  const stats = aic.getTokenStats();
  const config = loadConfig();
  const limits = config.tokenLimit || {};

  console.log(`\n📊 ${aic.t("tokensTitle")}\n`);

  if (limits.daily) {
    const dailyPercent = Math.round((stats.daily / limits.daily) * 100);
    console.log(`${aic.t("tokensToday")} ${stats.daily.toLocaleString()} / ${limits.daily.toLocaleString()} (${dailyPercent}%)`);
  } else {
    console.log(`${aic.t("tokensToday")} ${stats.daily.toLocaleString()} (${aic.t("tokensNoLimit")})`);
  }

  if (limits.monthly) {
    const monthlyPercent = Math.round((stats.monthly / limits.monthly) * 100);
    console.log(`${aic.t("tokensMonth")} ${stats.monthly.toLocaleString()} / ${limits.monthly.toLocaleString()} (${monthlyPercent}%)`);
  } else {
    console.log(`${aic.t("tokensMonth")} ${stats.monthly.toLocaleString()} (${aic.t("tokensNoLimit")})`);
  }

  console.log(`\n${aic.t("tokensLastReq")} ${stats.lastRequest} tokens`);
  console.log(`${aic.t("tokensSession")} ${stats.sessionTokens} tokens\n`);
}

async function mainCmd() {
  const config = loadConfig();
  const aic = await hook();
  aic.setLanguage(config.uiLanguage || config.language || "ru");

  switch (cmd) {
    case "init":
      await install();
      break;
    case "config":
      await configInteractive();
      break;
    case "uninstall":
      uninstall();
      break;
    case "status":
      showStatus();
      break;
    case "filter":
      await filterHistory();
      break;
    case "go":
      await quickFlow();
      break;
    case "split":
      await splitCommand();
      break;
    case "review":
      await reviewCommand();
      break;
    case "stats":
      await statsCommand();
      break;
    case "scan":
      await scanCommand();
      break;
    case "pr": {
      const baseIdx = args.indexOf("--base");
      const base = baseIdx !== -1 ? args[baseIdx + 1] : null;
      await prCommand(base);
      break;
    }
    case "release":
      await releaseCommand();
      break;
    case "tokens":
      await tokensCommand();
      break;
    case "update": {
      console.log("Updating RXDev...\n");
      const isPnpm = __dirname.includes("pnpm") || process.env.PNPM_HOME;
      const pm = isPnpm ? "pnpm" : "npm";
      // npm/pnpm are .cmd shims on Windows, which modern Node refuses to spawn
      // without a shell (CVE-2024-27980). Keep POSIX shell-free; use shell on Win.
      const pmOpts = { stdio: "inherit", shell: process.platform === "win32" };
      const upd = spawnSync(pm, ["add", "-g", "rxdev@latest"], pmOpts);
      if (upd.status === 0) {
        console.log("\n✅ RXDev updated successfully.");
      } else if (pm === "pnpm") {
        console.log("\n⚠️  pnpm update failed, trying npm...\n");
        const npmUpd = spawnSync("npm", ["install", "-g", "rxdev@latest"], pmOpts);
        if (npmUpd.status === 0) {
          console.log("\n✅ RXDev updated successfully.");
        } else {
          console.log(
            "\n❌ Update failed. Try manually:\n  pnpm add -g rxdev@latest\n  npm install -g rxdev@latest",
          );
        }
      } else {
        console.log(`\n❌ Update failed. Try manually:\n  npm install -g rxdev@latest`);
      }
      break;
    }
    case "version":
      console.log(`v${pkg.version}`);
      break;
    default: {
      if (!cmd || cmd.startsWith("-")) {
        showHelp(aic.t);
        break;
      }
      const aic2 = await hook();
      const suggestion = suggestCommand(cmd);
      if (suggestion) {
        console.log(`\n❌ Unknown command '${cmd}'`);
        console.log(`💡 Did you mean '${suggestion}'?\n`);
      } else {
        showHelp(aic2.t);
      }
    }
  }
}
process.on("unhandledRejection", (e) => {
  console.error(`\n❌ Unhandled error: ${e.message || e}`);
  process.exit(1);
});

mainCmd().catch((e) => {
  console.error(`\n❌ Error: ${e.message}`);
  process.exit(1);
});
