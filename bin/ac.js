#!/usr/bin/env node
import { spawnSync, spawn } from "child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import { homedir, tmpdir } from "os";
import updateNotifier from "update-notifier";
import { unlinkSync } from "fs";
import { createHash } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SOURCE_GITHOOKS_DIR = join(__dirname, "../.githooks");

const pkg = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf8"),
);


const update = updateNotifier({
  pkg,
  updateCheckInterval: 0,
}).update;

if (update?.latest && update.latest !== pkg.version) {
  const s = (str) => str.replace(/\x1b\[[0-9;]*m/g, "");
  const RED = "\x1b[31m", GREEN = "\x1b[32m", DIM = "\x1b[38;5;244m", RST = "\x1b[0m";

  const lines = [
    `Update available: ${RED}${pkg.version}${RST} → ${GREEN}${update.latest}${RST}`,
    `${DIM}pnpm add -g @rxgodev/neuro-commit@${update.latest}${RST}`,
  ];

  const maxWidth = Math.max(...lines.map((l) => s(l).length)) + 8;
  const top = "   ╭" + "─".repeat(maxWidth) + "╮";
  const bottom = "   ╰" + "─".repeat(maxWidth) + "╯";
  const pad = "   │" + " ".repeat(maxWidth) + "│";

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
ai_commit.mjs
ai_commit.py
ai_commit_debug.log
.env
.env.local
.commitignore
`;

// === CONFIGURATION ===
const CONFIG_DIR = join(homedir(), ".config", "ai-commit");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const MANAGED_PROJECTS_FILE = join(CONFIG_DIR, "managed-projects.json");
const TEMPLATES_FILE = join(CONFIG_DIR, "templates.json");

const DEFAULT_CONFIG = {
  coauthor: true,
  bumpVersion: false,
  language: "ru",
  provider: "groq",
};

// OpenAI-compatible providers (mirror of PROVIDERS in ai_commit.mjs).
const PROVIDERS = {
  groq: { label: "Groq (fast, free tier)", env: "GROQ_API_KEY", defaultModel: "llama-3.1-8b-instant" },
  openai: { label: "OpenAI", env: "OPENAI_API_KEY", defaultModel: "gpt-4o-mini" },
  openrouter: { label: "OpenRouter", env: "OPENROUTER_API_KEY", defaultModel: "openai/gpt-4o-mini" },
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
      return {
        ...DEFAULT_CONFIG,
        ...JSON.parse(readFileSync(CONFIG_FILE, "utf8")),
      };
    }
  } catch (e) {
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
    return (
      JSON.parse(readFileSync(MANAGED_PROJECTS_FILE, "utf8")).projects || []
    );
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
    writeFileSync(
      MANAGED_PROJECTS_FILE,
      JSON.stringify({ projects: filtered }, null, 2),
    );
  } catch {}
}

function fileHash(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function hashFilePath(pyPath) {
  return pyPath + ".sha256";
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

  // Update ai_commit.mjs with version/hash check
  const pySrc = join(SOURCE_GITHOOKS_DIR, "ai_commit.mjs");
  const pyDst = join(githooksDir, "ai_commit.mjs");
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
          if (current !== latest) { writePyWithHash(pyDst, latest); updated = true; }
        } else if (semverGt(latVer, curVer)) {
          writePyWithHash(pyDst, latest); updated = true;
        }
      }
    }
  }

  // Restore prepare-commit-msg if it's broken (missing call to ai_commit.mjs)
  const hookSrc = join(SOURCE_GITHOOKS_DIR, "prepare-commit-msg");
  const hookDst = join(githooksDir, "prepare-commit-msg");
  if (existsSync(hookSrc) && existsSync(hookDst)) {
    const installed = readFileSync(hookDst, "utf8");
    if (!installed.includes('ai_commit.mjs')) {
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

// The commit hook is now pure Node (ai_commit.mjs) — no Python/pathspec needed.
// git-filter-repo is only required for `qq filter`, which checks for it lazily
// (see checkFilterRepo) and points the user at `pip install git-filter-repo`.

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
    rl.question(`${question} (y/n): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}

async function promptSelect(options, message) {
  const inquirer = await import("inquirer");
  const { choice } = await inquirer.default.prompt([
    { type: "list", name: "choice", message, choices: options, pageSize: 20 },
  ]);
  return choice;
}

function spawnAsync(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { ...options, stdio: "ignore" });
    proc.on("close", resolve);
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
  const defaultContent =
    initial || '#!/bin/sh\nnode .githooks/ai_commit.mjs "$1"';
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

  const hasCall = lines.some((line) =>
    /node\s+\.githooks\/ai_commit\.mjs\s+"\$1"/.test(line) ||
    line.includes("node .githooks/ai_commit.mjs"),
  );

  if (!hasCall) {
    return 'Script must contain: node .githooks/ai_commit.mjs "$1"';
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
  const scriptPreview =
    tpl.script.length > 60 ? tpl.script.slice(0, 57) + "..." : tpl.script;

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
        console.log(
          `\n🔄 Updating template in ${tpl.appliedTo.length} project(s)...`,
        );
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
  while (true) {
    const templates = loadTemplates();
    const templateNames = Object.keys(templates);
    const choices = [
      ...templateNames.map((name) => ({ name, value: name })),
      { name: "➕ Create new template", value: "__new__" },
      { name: "⬅️ Back", value: "__back__" },
    ];

    const selected = await promptSelect(choices, "Templates");

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

// === PROJECTS LIST (TABLE) ===

function listProjects() {
  const allProjects = getManagedProjects();
  const valid = allProjects.filter((p) => existsSync(p));
  const invalid = allProjects.filter((p) => !existsSync(p));

  if (allProjects.length === 0) {
    console.log("📭 No integrated projects found.");
    return;
  }

  console.log(
    `\n📦 Integrated projects (${valid.length} active${invalid.length ? `, ${invalid.length} missing` : ""}):\n`,
  );

  const rows = [];

  valid.forEach((p) => {
    const name = p.split(/[\\/]/).pop();
    const template = getTemplateForProject(p) || "—";
    rows.push({ Status: "✅", Name: name, Template: template, Path: p });
  });

  invalid.forEach((p) => {
    const name = p.split(/[\\/]/).pop();
    const template = getTemplateForProject(p) || "—";
    rows.push({ Status: "❌", Name: name, Template: template, Path: p });
  });

  console.table(rows);

  if (invalid.length > 0) {
    console.log(
      '\n⚠️  Missing projects: run "qq uninstall" in them to clean up.\n',
    );
  }
}

// === FILE TREE HELPERS ===

function buildFileTree(files, prefix = "  ") {
  const tree = {};
  const rootFiles = [];

  for (const f of files) {
    const parts = f.split("/");
    if (parts.length === 1) {
      rootFiles.push(f);
    } else {
      const dir = parts[0];
      if (!tree[dir]) tree[dir] = [];
      tree[dir].push(f);
    }
  }

  const choices = [];
  const seenDirs = Object.keys(tree).sort();
  for (const dir of seenDirs) {
    choices.push({ name: `📁 ${dir}/`, value: `__dir__${dir}` });
    for (const f of tree[dir].sort()) {
      choices.push({ name: `${prefix}${f.slice(dir.length + 1)}`, value: f });
    }
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
      expanded.push(...allFiles.filter(f => f === dir || f.startsWith(dir + "/")));
    } else {
      expanded.push(s);
    }
  }
  return [...new Set(expanded)];
}

function addBackChoice(choices) {
  return [...choices, { name: "⬅️  Back", value: "__back__" }];
}

// === CONFIG INTERACTION ===

async function configInteractive() {
  const config = loadConfig();

  const provider = config.provider || "groq";
  const modelLabel = config.model
    || (PROVIDERS[provider]?.defaultModel ? `${PROVIDERS[provider].defaultModel} (default)` : "default");
  const providerLabel = PROVIDERS[provider]?.label || `custom (${config.apiUrl || "no url"})`;
  const langLabel = LANGUAGES[config.language] || "Русский";
  const mainAction = await promptSelect(
    [
      { name: "✅ Save & exit", value: "exit" },
      { name: "─".repeat(30), value: "__sep__" },
      {
        name: `🔌 Provider: ${providerLabel}`,
        value: "provider",
      },
      {
        name: `🧠 Model: ${modelLabel}`,
        value: "model",
      },
      {
        name: `🌐 Language: ${langLabel}`,
        value: "language",
      },
      {
        name: `✏️  Custom prompt: ${config.prompt ? "set" : "not set"}`,
        value: "prompt",
      },
      {
        name: `📝 Custom types: ${config.customTypes?.length ? config.customTypes.join(", ") : "not set"}`,
        value: "types",
      },
      {
        name: `🔑 API key: ${config.apiKey ? "configured" : "not set"}`,
        value: "apikey",
      },
      {
        name: `👥 Co-author: ${config.coauthor ? "enabled" : "disabled"}`,
        value: "coauthor",
      },
      {
        name: `📈 Auto-bump: ${config.bumpVersion ? "enabled" : "disabled"}`,
        value: "bump",
      },
      { name: "📂 Projects & Templates", value: "projects-templates" },
    ],
    "Configuration",
  );

  if (mainAction === "exit") return;
  if (mainAction === "__sep__") return;

  if (mainAction === "coauthor") {
    config.coauthor = !config.coauthor;
    saveConfig(config);
    console.log(
      config.coauthor
        ? "✅ Co-author enabled.\n"
        : "✅ Co-author disabled.\n",
    );
  }

  if (mainAction === "bump") {
    config.bumpVersion = !config.bumpVersion;
    saveConfig(config);
    console.log(
      config.bumpVersion
        ? "✅ Auto-bump enabled.\n"
        : "✅ Auto-bump disabled.\n",
    );
  }

  if (mainAction === "apikey") {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const masked = config.apiKey
      ? config.apiKey.slice(0, 8) + "..." + config.apiKey.slice(-4)
      : "not set";
    const key = await new Promise((resolve) => {
      rl.question(`🔑 API key (current: ${masked})\n   Enter new key (or empty to clear): `, resolve);
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
        message: "Select LLM provider:",
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
        message: `Model name (empty = provider default${PROVIDERS[chosen]?.defaultModel ? `: ${PROVIDERS[chosen].defaultModel}` : ""}):`,
        default: config.model || "",
      },
    ]);
    config.model = model.trim();
    saveConfig(config);
    const keyHint = chosen === "ollama"
      ? " (no API key needed)"
      : (config.apiKey ? "" : " — remember to set an API key");
    console.log(`✅ Provider: ${config.provider}${config.model ? `, model: ${config.model}` : ""}${keyHint}.\n`);
  }

  if (mainAction === "model") {
    const inquirer = await import("inquirer");
    const prov = config.provider || "groq";
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
      config.model = model;
      saveConfig(config);
      console.log(`✅ Model set to ${model.includes("70b") ? "70B" : "8B"}.\n`);
    } else {
      const { model } = await inquirer.default.prompt([
        {
          type: "input",
          name: "model",
          message: `Model name for ${prov} (empty = default${PROVIDERS[prov]?.defaultModel ? `: ${PROVIDERS[prov].defaultModel}` : ""}):`,
          default: config.model || "",
        },
      ]);
      config.model = model.trim();
      saveConfig(config);
      console.log(config.model ? `✅ Model set to ${config.model}.\n` : "ℹ️  Using provider default model.\n");
    }
  }

  if (mainAction === "language") {
    const inquirer = await import("inquirer");
    const { lang } = await inquirer.default.prompt([
      {
        type: "list",
        name: "lang",
        message: "Select commit message language:",
        choices: Object.entries(LANGUAGES).map(([code, name]) => ({
          name: `${name} (${code})`,
          value: code,
        })),
        default: config.language || "ru",
      },
    ]);
    config.language = lang;
    saveConfig(config);
    console.log(`✅ Language set to ${LANGUAGES[lang]}.\n`);
  }

  if (mainAction === "prompt") {
    const inquirer = await import("inquirer");
    const { prompt } = await inquirer.default.prompt([
      {
        type: "editor",
        name: "prompt",
        message: "Edit system prompt (use {types} placeholder for allowed types):",
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
    const parsed = types.split(",").map((t) => t.trim()).filter(Boolean);
    config.customTypes = parsed;
    saveConfig(config);
    console.log(
      parsed.length
        ? `✅ Custom types: ${parsed.join(", ")}\n`
        : "ℹ️  Custom types cleared.\n",
    );
  }

  if (mainAction === "projects-templates") {
    const ptAction = await promptSelect(
      [
        { name: "📋 List all projects", value: "list-projects" },
        { name: "🎨 Templates", value: "templates" },
        { name: "🔌 Disable hook in project", value: "disable-hook" },
        { name: "⬅️ Back", value: "back" },
      ],
      "Projects & Templates",
    );

    if (ptAction === "list-projects") {
      listProjects();
    } else if (ptAction === "templates") {
      await manageTemplates();
    } else if (ptAction === "disable-hook") {
      const allProjects = getManagedProjects().filter((p) => existsSync(p));
      if (allProjects.length === 0) {
        console.log("📭 No managed projects found.");
      } else {
        const dInq = await import("inquirer");
        const { target } = await dInq.default.prompt([
          {
            type: "list",
            name: "target",
            message: "Select project to disable hook:",
            choices: allProjects.map(p => ({ name: `${p.split(/[\\/]/).pop()} → ${p}`, value: p })),
          },
        ]);
        const githooks = join(target, ".githooks");
        if (existsSync(githooks)) {
          rmSync(githooks, { recursive: true, force: true });
        }
        spawnSync("git", ["config", "--unset", "core.hooksPath"], { stdio: "ignore", cwd: target });
        unregisterProject(target);
        console.log(`\n✅ Hook disabled for ${target.split(/[\\/]/).pop()}\n`);
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
    const newContent = content.trimEnd() + `\n${entry}\n`;
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

  for (const file of ["ai_commit.mjs", "prepare-commit-msg"]) {
    const src = join(SOURCE_GITHOOKS_DIR, file);
    const dst = join(githooksDir, file);
    if (!existsSync(src)) {
      console.error(`❌ Missing: ${src}`);
      process.exit(1);
    }
    const content = readFileSync(src, "utf8");
    if (file === "ai_commit.mjs") {
      writePyWithHash(dst, content);
    } else {
      writeFileSync(dst, content);
    }
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

  console.log("🎉 NeuroCommit installed successfully!");
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
  console.log("🗑️ NeuroCommit uninstalled!");
}

function showStatus() {
  const cwd = process.cwd();
  const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    stdio: "pipe",
    encoding: "utf8",
  });

  if (gitRoot.status !== 0) {
    console.log("❌ Not inside a Git repository.");
    return;
  }

  const root = gitRoot.stdout.trim();
  const githooksDir = join(root, ".githooks");
  const hookPath = join(githooksDir, "prepare-commit-msg");
  const commitignorePath = join(root, ".commitignore");

  const hooksPathResult = spawnSync("git", ["config", "core.hooksPath"], {
    stdio: "pipe",
    encoding: "utf8",
  });
  const configuredHooksPath =
    hooksPathResult.status === 0 ? hooksPathResult.stdout.trim() : null;
  const hooksConfigured = configuredHooksPath === ".githooks";

  const hookExists = existsSync(hookPath);

  const commitignoreExists = existsSync(commitignorePath);

  const templateName = getTemplateForProject(root) || "—";
  const cfg = loadConfig();

  console.log("\n🔍 NeuroCommit Status\n");
  console.log(`📁 Git root:       ${root}`);
  console.log(
    `⚙️  Hooks path:     ${hooksConfigured ? "✅ .githooks" : "❌ not set"}`,
  );
  console.log(
    `📜 Hook file:       ${hookExists ? "✅ present" : "❌ missing"}`,
  );
  console.log(
    `📄 .commitignore:   ${commitignoreExists ? "✅ exists" : "⚠️ missing"}`,
  );
  const prov = cfg.provider || "groq";
  const envName = PROVIDERS[prov]?.env;
  const hasKey = !!cfg.apiKey || (envName && !!process.env[envName]) || !!process.env.NEURO_COMMIT_API_KEY;
  const keyState = prov === "ollama" ? "no key needed (local)" : (hasKey ? "API key configured" : "API key needed — run 'qq config'");
  console.log(`🌐 Provider:        ${prov}${cfg.model ? ` · ${cfg.model}` : ""} (${keyState})`);
  console.log(
    `📈 Auto-bump:       ${cfg.bumpVersion ? "✅ enabled" : "— disabled"}`,
  );
  console.log(`🎨 Template:        ${templateName}`);
  console.log("");
}

// === DOCTOR ===

function doctor() {
  const ok = (s) => `✅ ${s}`;
  const bad = (s) => `❌ ${s}`;
  const warn = (s) => `⚠️  ${s}`;

  console.log("\n🩺 NeuroCommit Doctor\n");

  // Node version (the hook runtime; >= 18 required)
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  console.log(nodeMajor >= 18
    ? ok(`Node: ${process.version}`)
    : bad(`Node ${process.version} is too old — need >= 18`));

  // git-filter-repo (optional, only for `qq filter`)
  const fr = spawnSync("git", ["filter-repo", "--version"], { stdio: "pipe" });
  console.log(fr.status === 0
    ? ok("Optional: git-filter-repo")
    : warn("git-filter-repo not installed (only needed for 'qq filter')"));

  // git repo, hooks path, hook files
  const rootRes = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (rootRes.status !== 0) {
    console.log(bad("Not inside a git repository"));
    console.log("");
    return;
  }
  const gitRoot = rootRes.stdout.trim();
  const hp = spawnSync("git", ["config", "core.hooksPath"], { encoding: "utf8" });
  const hooksPath = hp.status === 0 ? hp.stdout.trim() : "";
  console.log(hooksPath === ".githooks"
    ? ok("Hooks path: .githooks")
    : bad(`Hooks path not set — run 'qq init' (current: ${hooksPath || "unset"})`));

  const hookFile = join(gitRoot, ".githooks", "prepare-commit-msg");
  console.log(existsSync(hookFile) ? ok("Hook: prepare-commit-msg present") : bad("Hook missing — run 'qq init'"));

  const pyFile = join(gitRoot, ".githooks", "ai_commit.mjs");
  if (existsSync(pyFile)) {
    const hashPath = hashFilePath(pyFile);
    if (existsSync(hashPath)) {
      const stored = readFileSync(hashPath, "utf8").trim();
      const cur = fileHash(readFileSync(pyFile, "utf8"));
      console.log(stored === cur ? ok("Hook: ai_commit.mjs integrity OK") : warn("ai_commit.mjs changed since install (hash mismatch)"));
    } else {
      console.log(warn("ai_commit.mjs present but no .sha256 sidecar"));
    }
  } else {
    console.log(bad("ai_commit.mjs missing — run 'qq init'"));
  }

  // provider / key
  const cfg = loadConfig();
  const prov = cfg.provider || "groq";
  const envName = PROVIDERS[prov]?.env;
  const hasKey = !!cfg.apiKey || (envName && !!process.env[envName]) || !!process.env.NEURO_COMMIT_API_KEY;
  console.log(`\n🌐 Provider: ${prov}${cfg.model ? ` · ${cfg.model}` : ""}`);
  if (prov === "ollama") {
    console.log(ok("API key: not required (local)"));
  } else {
    console.log(hasKey ? ok("API key: configured") : bad(`API key: not set (config or ${envName || "env"})`));
  }
  console.log(`📈 Auto-bump: ${cfg.bumpVersion ? "enabled" : "disabled"}`);
  console.log("");
}

// === FILTER-REPO ===

async function checkFilterRepo() {
  const r = spawnSync("git", ["filter-repo", "--version"], { stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) {
    console.error("❌ git-filter-repo not found. Install it:\n");
    console.error("  pip install git-filter-repo\n");
    console.error("  Or run: qq init");
    process.exit(1);
  }
  return r.stdout.trim();
}

async function filterHistory() {
  const version = await checkFilterRepo();
  console.log(`\n🔧 git-filter-repo ${version}\n`);

  const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
  console.log(`📁 Repository: ${gitRoot}\n`);

  const bold = "\x1b[1m";
  const red = "\x1b[31m";
  const green = "\x1b[32m";
  const reset = "\x1b[0m";
  const dim = "\x1b[38;5;244m";

  const inq = await import("inquirer");

  while (true) {
      const { operation } = await inq.default.prompt([
        {
          type: "list",
          name: "operation",
          message: "Select operation:",
          choices: [
            { name: "🗑️  Remove file/folder from history", value: "remove-file" },
            { name: "🔑 Replace text in history (e.g. secret key)", value: "replace-text" },
            { name: "⬅️  Back", value: "back" },
          ],
        },
      ]);

      if (operation === "back") return;

      let args = ["filter-repo", "--force"];
      let replaceTextFile = null;

      if (operation === "remove-file") {
        const allFiles = spawnSync("git", ["ls-files"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
        const fInq = await import("inquirer");
        const { filePaths } = await fInq.default.prompt([
          {
            type: "checkbox",
            name: "filePaths",
            message: "Select files/folders to remove from history (empty = back):",
            choices: buildFileTree(allFiles),
            pageSize: 20,
          },
        ]);
        if (!filePaths.length) continue;
        const expanded = expandDirSelections(filePaths, allFiles);
        for (const fp of expanded) args.push("--path", fp, "--invert-paths");

        const { addGitignore } = await fInq.default.prompt([
          { type: "confirm", name: "addGitignore", message: "Add to .gitignore?", default: true },
        ]);
        if (addGitignore) {
          const gitignorePath = join(gitRoot, ".gitignore");
          let content = "";
          if (existsSync(gitignorePath)) content = readFileSync(gitignorePath, "utf8");
          const gitignoreEntries = filePaths
            .filter(f => f.startsWith("__dir__"))
            .map(f => f.slice(7) + "/")
            .concat(filePaths.filter(f => !f.startsWith("__dir__") && !f.startsWith("__")));
          let added = 0;
          for (const entry of [...new Set(gitignoreEntries)]) {
            if (!content.includes(entry)) {
              content = content.trimEnd() + `\n${entry}\n`;
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
      replaceTextFile = join(tmpdir(), `neuro-commit-replace-${process.pid}.txt`);
      writeFileSync(replaceTextFile, expr + "\n");
      args.push("--replace-text", replaceTextFile);
    }

    console.log(`\n${red}${bold}⚠️  WARNING: This will REWRITE git history!${reset}`);
    console.log(`${dim}This is a destructive operation. Make sure you have a backup.${reset}\n`);

    const { confirm } = await inq.default.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: `Run: git ${args.join(" ")}`,
        default: false,
      },
    ]);

    if (!confirm) {
      console.log("↩️  Cancelled.\n");
      continue;
    }

    console.log(`\n🔄 Rewriting history...\n`);
    const result = spawnSync("git", args, { stdio: "inherit" });
    if (replaceTextFile) { try { unlinkSync(replaceTextFile); } catch {} }
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
  const bold = "\x1b[1m";
  const dim = "\x1b[38;5;244m";
  const reset = "\x1b[0m";
  const green = "\x1b[32m";
  const cyan = "\x1b[36m";
  const yellow = "\x1b[33m";

  const sa = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

  const clearScreen = () => process.stdout.write("\x1b[2J\x1b[H");

  // ── Header box (only boxed element) ──
  const showHeader = () => {
    clearScreen();
    const lines = [`${bold}🚀  NeuroCommit QuickFlow®${reset}`];
    const w = Math.max(...lines.map((l) => sa(l).length)) + 4;
    const o = "╭" + "─".repeat(w) + "╮\n" +
      "│" + " ".repeat(w) + "│\n" +
      "│" + " ".repeat(Math.floor((w - sa(lines[0]).length) / 2)) + lines[0] +
      " ".repeat(w - sa(lines[0]).length - Math.floor((w - sa(lines[0]).length) / 2)) + "│\n" +
      "│" + " ".repeat(w) + "│\n" +
      "╰" + "─".repeat(w) + "╯\n";
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

  console.log(`\n${sep(`${bold}📂  Stage Changes${reset}`)}\n`);

  const unstaged = spawnSync("git", ["diff", "--name-only"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
  const alreadyStaged = spawnSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
  const allChanged = [...new Set([...unstaged, ...alreadyStaged])];

  const sInq = await import("inquirer");
  const fileChoices = allChanged.length === 0 ? [] : [
    { name: "📦 Stage all files", value: "__all__" },
    { name: "─".repeat(30), value: "__sep__" },
    ...buildFileTree(allChanged).map(c => ({
      ...c,
      checked: c.value.startsWith("__dir__") ? allChanged.filter(f => f === c.value.slice(7) || f.startsWith(c.value.slice(7) + "/")).every(f => alreadyStaged.includes(f)) : (c.value === "__all__" ? false : alreadyStaged.includes(c.value)),
    })),
  ];

  if (allChanged.length === 0) {
    console.log("ℹ️  No changed files found.\n");
  }

  let filesToStage = [];

  while (true) {
    const { selectedFiles } = allChanged.length === 0
      ? { selectedFiles: [] }
      : await sInq.default.prompt([
          {
            type: "checkbox",
            name: "selectedFiles",
            message: "Select files to stage:",
            choices: addBackChoice(fileChoices),
            pageSize: 20,
          },
        ]);

    if (selectedFiles.includes("__back__")) {
      if (filesToStage.length === 0) return;
      break;
    }

    if (selectedFiles.includes("__all__") || selectedFiles.includes("__sep__")) {
      if (selectedFiles.length === 1 && selectedFiles[0] === "__all__") {
        filesToStage = allChanged;
        break;
      }
      if (selectedFiles.length === 1 && selectedFiles[0] === "__sep__") continue;
    }

    const filtered = selectedFiles.filter(f => f !== "__sep__" && f !== "__all__");
    filesToStage = expandDirSelections(filtered, allChanged);
    if (filesToStage.length > 0) break;
  }

  if (filesToStage.length > 0) {
    const addResult = spawnSync("git", ["add", ...filesToStage], { stdio: "pipe" });
    if (addResult.status !== 0) { console.error("❌ Failed to stage changes."); process.exit(1); }
    console.log(`${green}✅ ${filesToStage.length} file(s) staged${reset}\n`);
  }

  // ── Secret scan before committing ──
  const secrets = await scanSecrets();
  if (secrets.length > 0) {
    console.log(`${yellow}🚨 ${secrets.length} potential secret(s) in staged changes:${reset}`);
    for (const f of secrets) console.log(`   • ${f.type} — ${f.file} (${f.preview})`);
    const carryOn = await askYesNo("Commit anyway?");
    if (!carryOn) { console.log(`\n${bold}↩️  Aborted — unstage the secrets and retry.${reset}`); return; }
  }

  // ================================================================
  //  STEP 2 — Generate
  // ================================================================
  showHeader();

  console.log(`\n${sep(`${bold}💬  Generating Commit Message${reset}`)}\n`);
  console.log(`${dim}AI is analyzing your staged changes...${reset}\n`);

  const makeCommit = (skipBump) => new Promise((resolve) => {
    const child = spawn("git", ["commit", "--quiet"], {
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, GIT_EDITOR: "true", ...(skipBump ? { NEURO_COMMIT_SKIP_BUMP: "1" } : {}) },
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
  if (commitCode === null) { process.exit(130); }
  if (commitCode !== 0) {
    const commitMsgFile = join(process.cwd(), ".git", "COMMIT_EDITMSG");
    try {
      const raw = readFileSync(commitMsgFile, "utf8");
      const userLines = raw.split("\n").filter(l => {
        const t = l.trim();
        return t && !t.startsWith("# On ") && !t.startsWith("# Please") && !t.startsWith("# It looks") && !t.startsWith("# Your branch") && !t.startsWith("# Changes") && !t.startsWith("# Untracked") && !t.startsWith("#");
      });
      if (userLines.length > 0) {
        console.log(`\n${userLines.join("\n")}\n`);
      }
    } catch {}
    console.error("❌ Failed to generate commit message");
    process.exit(1);
  }

  const commitMsgFile = join(process.cwd(), ".git", "COMMIT_EDITMSG");
  let currentMessage = readFileSync(commitMsgFile, "utf8").trim()
    .split("\n").filter((l) => !l.trim().startsWith("#")).join("\n").trim();

  if (!currentMessage) { console.error("❌ Empty commit message"); process.exit(1); }

  // ================================================================
  //  REVIEW LOOP
  // ================================================================
  const inq = await import("inquirer");

  const showReview = () => {
    clearScreen();
    showHeader();
    console.log(`\n${sep(`${bold}📄  Commit Message${reset}`)}\n`);

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

  while (true) {
    const { action } = await inq.default.prompt([
      { type: "list", name: "action", message: "What next?",
        choices: [
          { name: `${green}✅  Push${reset}`, value: "push" },
          { name: `${cyan}✏️   Edit message${reset}`, value: "edit" },
          { name: `${yellow}🔄  Regenerate${reset}`, value: "regenerate" },
          { name: `${bold}❌  Cancel${reset}`, value: "cancel" },
        ], default: "push",
      },
    ]);

    if (action === "push") break;
    if (action === "cancel") {
      spawnSync("git", ["reset", "--soft", "HEAD~1"], { stdio: "pipe" });
      console.log(`\n${bold}↩️  Commit cancelled${reset}`);
      return;
    }

    if (action === "edit") {
      writeFileSync(commitMsgFile, currentMessage, "utf8");
      const defaultEditor = process.platform === "win32" ? "notepad" : "vi";
      const editor = process.env.GIT_EDITOR || process.env.VISUAL || process.env.EDITOR || defaultEditor;
      const editRes = spawnSync(editor, [commitMsgFile], { stdio: "inherit", shell: false });
      if (editRes.status !== 0) { console.log(`\n${yellow}↩️  Edit cancelled${reset}`); continue; }
      const edited = readFileSync(commitMsgFile, "utf8").trim()
        .split("\n").filter((l) => !l.trim().startsWith("#")).join("\n").trim();
      if (!edited) { console.log(`\n${yellow}❌ Empty message${reset}`); continue; }
      writeFileSync(commitMsgFile, edited, "utf8");
      const amend = spawnSync("git", ["commit", "--amend", "-F", commitMsgFile], {
        stdio: "inherit", env: { ...process.env, GIT_EDITOR: "true" },
      });
      if (amend.status !== 0) { console.error("❌ Amend failed"); process.exit(1); }
      currentMessage = edited;
      showReview();
    }

    if (action === "regenerate") {
      spawnSync("git", ["reset", "--soft", "HEAD~1"], { stdio: "pipe" });
      showHeader();
      console.log(`\n${sep(`${bold}💬  Regenerating Commit Message${reset}`)}\n`);
      console.log(`${dim}AI is re-analyzing your changes...${reset}\n`);
      const c = await makeCommit(true);
      console.log("");
      if (c === null) { process.exit(130); }
      if (c !== 0) { console.error("❌ Failed to regenerate"); process.exit(1); }
      currentMessage = readFileSync(commitMsgFile, "utf8").trim()
        .split("\n").filter((l) => !l.trim().startsWith("#")).join("\n").trim();
      if (!currentMessage) { console.error("❌ Empty message"); process.exit(1); }
      showReview();
    }
  }

  // ================================================================
  //  STEP 3 — Push
  // ================================================================
  showHeader();

  console.log(`\n${sep(`${bold}⬆️  Push Changes${reset}`)}\n`);

  const remotes = spawnSync("git", ["remote"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
  const allBranches = spawnSync("git", ["branch", "--format=%(refname:short)"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
  const currentBranch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout.trim();

  const inqPush = await import("inquirer");
  const remoteChoices = addBackChoice(
    remotes.length ? remotes.map(r => ({ name: r, value: r })) : [{ name: "origin", value: "origin" }]
  );
  const { remote } = await inqPush.default.prompt([
    {
      type: "list",
      name: "remote",
      message: "Select remote:",
      choices: remoteChoices,
      default: remotes.includes("origin") ? "origin" : (remotes[0] || "origin"),
    },
  ]);
  if (remote === "__back__") return;

  const branchChoices = addBackChoice(
    allBranches.length ? allBranches.map(b => ({ name: b, value: b })) : [{ name: "main", value: "main" }]
  );
  const { branch } = await inqPush.default.prompt([
    {
      type: "list",
      name: "branch",
      message: "Select branch:",
      choices: branchChoices,
      default: currentBranch || "main",
    },
  ]);
  if (branch === "__back__") return;

  console.log(`\n⬆️  Pushing to ${remote}/${branch}...`);
  const push = spawnSync("git", ["push", remote, branch], { stdio: "inherit" });
  if (push.status !== 0) { console.error("\n❌ Push failed"); process.exit(1); }
  console.log(`${green}✅ Pushed successfully${reset}\n`);
}

// === SCAN / RELEASE / PR / SPLIT (in-process via the Node hook module) ===

let _hookModule = null;
async function hook() {
  if (!_hookModule) _hookModule = await import(join(SOURCE_GITHOOKS_DIR, "ai_commit.mjs"));
  return _hookModule;
}
function hookConfig(aic) {
  return aic.resolveConfig(aic.loadUserConfig());
}

async function scanSecrets() {
  const aic = await hook();
  return aic.scanStagedSecrets();
}

async function scanCommand() {
  const findings = await scanSecrets();
  if (!findings.length) {
    console.log("\n✅ No secrets detected in staged changes.\n");
    return;
  }
  console.log(`\n🚨 ${findings.length} potential secret(s) in staged changes:\n`);
  for (const f of findings) {
    console.log(`  • ${f.type} — ${f.file}  (${f.preview})`);
  }
  console.log("\n   Unstage or remove these before committing.");
  console.log("   Already committed? Use 'qq filter' to purge from history.\n");
}

async function releaseCommand() {
  const aic = await hook();
  const data = aic.buildReleaseInfo();
  if (!data || data.error) {
    console.error(`\n❌ ${data?.error || "Could not compute release."}`);
    process.exit(1);
  }
  const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();

  console.log(`\n🏷️  Release\n`);
  console.log(`   Since:   ${data.from || "(no tags — summarizing all history)"}`);
  console.log(`   Current: ${data.current}`);
  console.log(`   Bump:    ${data.bump}  →  ${data.next}`);
  console.log(`   Commits: ${data.count}\n`);
  console.log("──────── CHANGELOG entry ────────\n");
  console.log(data.changelog);
  console.log("─────────────────────────────────\n");

  if (data.count === 0) {
    console.log("Nothing to release since the last tag.\n");
    return;
  }

  const proceed = await askYesNo(`Write CHANGELOG.md and create tag v${data.next}?`);
  if (!proceed) {
    console.log("↩️  Cancelled.\n");
    return;
  }

  const clPath = join(gitRoot, "CHANGELOG.md");
  const titleBlock = "# Changelog\n\nAll notable changes to this project are documented here.\n";
  const entry = data.changelog.trim() + "\n";
  let out;
  if (existsSync(clPath)) {
    const existing = readFileSync(clPath, "utf8");
    const idx = existing.indexOf("\n## ");
    if (idx !== -1) {
      out = existing.slice(0, idx + 1) + "\n" + entry + "\n" + existing.slice(idx + 1);
    } else {
      out = existing.trimEnd() + "\n\n" + entry;
    }
  } else {
    out = titleBlock + "\n" + entry;
  }
  writeFileSync(clPath, out);
  console.log("✅ CHANGELOG.md updated");

  spawnSync("git", ["add", "--", clPath], { stdio: "pipe" });
  const tag = `v${data.next}`;
  const commitRes = spawnSync("git", ["commit", "-m", `chore(release): ${tag}`], {
    stdio: "inherit",
    env: { ...process.env, NEURO_COMMIT_SKIP_BUMP: "1", GIT_EDITOR: "true" },
  });
  if (commitRes.status !== 0) {
    console.error("❌ Release commit failed (nothing staged?).");
    process.exit(1);
  }
  const tagRes = spawnSync("git", ["tag", "-a", tag, "-m", tag], { stdio: "inherit" });
  if (tagRes.status !== 0) {
    console.error(`❌ Failed to create tag ${tag} (already exists?).`);
    process.exit(1);
  }
  console.log(`✅ Committed and tagged ${tag}`);

  const doPush = await askYesNo("Push commit and tag to origin?");
  if (doPush) {
    const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout.trim();
    spawnSync("git", ["push", "origin", branch], { stdio: "inherit" });
    spawnSync("git", ["push", "origin", tag], { stdio: "inherit" });
    console.log("✅ Pushed.\n");
  } else {
    console.log(`\nℹ️  When ready: git push && git push origin ${tag}\n`);
  }
}

async function prCommand() {
  const baseIdx = args.indexOf("--base");
  const base = baseIdx !== -1 ? args[baseIdx + 1] : null;
  console.log("\n💬 Generating pull request description...\n");
  const aic = await hook();
  const data = await aic.buildPrInfo(base, hookConfig(aic));
  if (!data || data.error) {
    console.error(`\n❌ ${data?.error || "PR generation failed."}`);
    process.exit(1);
  }
  console.log(`📌 Title: ${data.title}\n`);
  console.log(data.body);
  console.log("");

  const hasGh = spawnSync("gh", ["--version"], { stdio: "pipe" }).status === 0;
  if (hasGh) {
    const create = await askYesNo(`Create the PR with gh (base: ${data.base})?`);
    if (create) {
      const tmp = join(tmpdir(), `neuro-commit-pr-${process.pid}.md`);
      writeFileSync(tmp, data.body);
      const r = spawnSync("gh", ["pr", "create", "--base", data.base, "--title", data.title, "--body-file", tmp], { stdio: "inherit" });
      try { unlinkSync(tmp); } catch {}
      if (r.status !== 0) console.error("❌ gh pr create failed.");
    }
  } else {
    console.log("ℹ️  Install GitHub CLI (gh) to open the PR directly from here.\n");
  }
}

async function splitCommand() {
  console.log("\n✂️  Analyzing staged changes...\n");
  const aic = await hook();
  const data = await aic.buildSplitPlan(hookConfig(aic));
  if (!data || data.error) {
    console.error(`\n❌ ${data?.error || "Split failed."}`);
    process.exit(1);
  }
  const groups = data.groups || [];
  if (!groups.length) {
    console.log("ℹ️  No split plan was produced.\n");
    return;
  }

  console.log(`Proposed ${groups.length} commit(s):\n`);
  groups.forEach((g, i) => {
    console.log(`  ${i + 1}. ${g.message}`);
    if (g.reason) console.log(`      ↳ ${g.reason}`);
    g.files.forEach((f) => console.log(`        - ${f}`));
    console.log("");
  });
  if (data.unassigned?.length) {
    console.log(`⚠️  Left staged (unassigned): ${data.unassigned.join(", ")}\n`);
  }

  const apply = await askYesNo("Apply this split? (creates the commits above)");
  if (!apply) {
    console.log("↩️  Staging left unchanged.\n");
    return;
  }

  const staged = data.staged || [];
  const reStageAll = () => spawnSync("git", ["add", "--", ...staged], { stdio: "pipe" });
  for (const g of groups) {
    spawnSync("git", ["reset", "-q", "--", ...staged], { stdio: "pipe" });
    const addRes = spawnSync("git", ["add", "--", ...g.files], { stdio: "pipe" });
    if (addRes.status !== 0) {
      console.error("❌ Failed to stage a group — aborting and restoring staging.");
      reStageAll();
      process.exit(1);
    }
    const c = spawnSync("git", ["commit", "-m", g.message], {
      stdio: "inherit",
      env: { ...process.env, NEURO_COMMIT_SKIP_BUMP: "1", GIT_EDITOR: "true" },
    });
    if (c.status !== 0) {
      console.error("❌ A commit failed — aborting and restoring staging.");
      reStageAll();
      process.exit(1);
    }
    console.log(`✅ ${g.message}`);
  }
  if (data.unassigned?.length) {
    spawnSync("git", ["add", "--", ...data.unassigned], { stdio: "pipe" });
  }
  console.log(`\n✅ Created ${groups.length} commit(s).\n`);
}

function showHelp() {
  console.log(`${boldCyan}NeuroCommit${resetColor} is a AI-powered conventional commit messages ${"\x1b[38;5;244m"}(v${pkg.version})${resetColor}

${"\x1b[1m\x1b[37m"}Usage:${resetColor}
  ${boldCyan}qq${resetColor} <command> [options]

${"\x1b[1m\x1b[37m"}Commands:${resetColor}
  ${boldCyan}init${resetColor}          Install AI commit hook
  ${boldCyan}config${resetColor}        Configure model, language, key, prompt, types, co-author & more
  ${boldCyan}go${resetColor}            Start QuickFlow® — interactive commit flow
  ${boldCyan}split${resetColor}         Split staged changes into multiple logical commits
  ${boldCyan}scan${resetColor}          Scan staged changes for secrets/credentials
  ${boldCyan}pr${resetColor}            Generate a pull request title + description
  ${boldCyan}release${resetColor}       Generate CHANGELOG entry, bump version & tag
  ${boldCyan}uninstall${resetColor}     Remove hook
  ${boldCyan}status${resetColor}        Show integration status
  ${boldCyan}doctor${resetColor}        Diagnose setup (Node, hooks, provider, key)
  ${boldCyan}filter${resetColor}        Rewrite git history (remove secrets, files, etc.)
  ${boldCyan}version${resetColor}       Show version number
  ${boldCyan}update${resetColor}        Show update instructions`);
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
  showHelp();
  process.exit(0);
}

// === AUTO-UPDATE MANAGED PROJECTS' HOOKS ===
// Only on an explicit `qq update`. Previously this ran on almost every command,
// silently rewriting the hooks of OTHER managed repos whenever the user ran qq
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
async function mainCmd() {
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
    case "doctor":
      doctor();
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
    case "scan":
      await scanCommand();
      break;
    case "pr":
      await prCommand();
      break;
    case "release":
      await releaseCommand();
      break;
    case "update":
      console.log("Updating NeuroCommit...\n");
      const isPnpm = __dirname.includes("pnpm") || process.env.PNPM_HOME;
      const pm = isPnpm ? "pnpm" : "npm";
      const upd = spawnSync(pm, ["add", "-g", "@rxgodev/neuro-commit@latest"], { stdio: "inherit", shell: true });
      if (upd.status === 0) {
        console.log("\n✅ NeuroCommit updated successfully.");
      } else if (pm === "pnpm") {
        console.log("\n⚠️  pnpm update failed, trying npm...\n");
        const npmUpd = spawnSync("npm", ["install", "-g", "@rxgodev/neuro-commit@latest"], { stdio: "inherit", shell: true });
        if (npmUpd.status === 0) {
          console.log("\n✅ NeuroCommit updated successfully.");
        } else {
          console.log("\n❌ Update failed. Try manually:\n  pnpm add -g @rxgodev/neuro-commit@latest\n  npm install -g @rxgodev/neuro-commit@latest");
        }
      } else {
        console.log(`\n❌ Update failed. Try manually:\n  npm install -g @rxgodev/neuro-commit@latest`);
      }
      break;
    case "version":
      console.log(`v${pkg.version}`);
      break;
    default:
      showHelp();
  }
}
mainCmd().catch((e) => {
  console.error(`\n❌ Error: ${e.message}`);
  process.exit(1);
});
