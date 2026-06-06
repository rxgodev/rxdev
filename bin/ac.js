#!/usr/bin/env node
import { spawnSync, spawn } from "child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import { homedir } from "os";
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

function unregisterProject() {
  if (!existsSync(MANAGED_PROJECTS_FILE)) return;
  try {
    const data = JSON.parse(readFileSync(MANAGED_PROJECTS_FILE, "utf8"));
    const filtered = data.projects.filter((p) => p !== process.cwd());
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
  const m = content.match(/^NEURO_COMMIT_VERSION\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

function semverGt(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

function updateProjectHooks(projectPath) {
  const githooksDir = join(projectPath, ".githooks");
  if (!existsSync(githooksDir)) return false;
  let updated = false;

  // Update ai_commit.py with version/hash check
  const pySrc = join(SOURCE_GITHOOKS_DIR, "ai_commit.py");
  const pyDst = join(githooksDir, "ai_commit.py");
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

  // Restore prepare-commit-msg if it's broken (missing call to ai_commit.py)
  const hookSrc = join(SOURCE_GITHOOKS_DIR, "prepare-commit-msg");
  const hookDst = join(githooksDir, "prepare-commit-msg");
  if (existsSync(hookSrc) && existsSync(hookDst)) {
    const installed = readFileSync(hookDst, "utf8");
    if (!installed.includes('ai_commit.py')) {
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

function checkPython() {
  for (const cmd of ["python3", "python"]) {
    try {
      if (spawnSync(cmd, ["--version"], { stdio: "pipe" }).status === 0)
        return cmd;
    } catch {}
  }
  console.error("❌ Python 3.8+ is required but not found.");
  process.exit(1);
}

function installPythonDeps() {
  const pythonCmd = checkPython();

  const result = spawnSync(pythonCmd, ["-c", "import pathspec"], {
    stdio: "pipe",
  });

  if (result.status !== 0) {
    const isVenv = process.env.VIRTUAL_ENV || process.env.CONDA_PREFIX;

    if (isVenv) {
      const venvName = (process.env.VIRTUAL_ENV || process.env.CONDA_PREFIX)
        .split(/[\\/]/)
        .pop();
      console.error(`\n❌ Missing dependency: pathspec`);
      console.error(`\n   You're in venv "${venvName}". Install manually:\n`);
      console.error(`   pip install pathspec\n`);
      process.exit(1);
    }

    // Не в venv — устанавливаем сами
    console.log("📦 Installing pathspec...");
    const install = spawnSync(
      pythonCmd,
      ["-m", "pip", "install", "--quiet", "pathspec"],
      {
        stdio: "inherit",
      },
    );

    if (install.status !== 0) {
      console.error("❌ Failed to install pathspec. Try: pip install pathspec");
      process.exit(1);
    }
  }
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
    initial || '#!/bin/sh\npython .githooks/ai_commit.py "$1"';
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
      line.includes('python .githooks/ai_commit.py "$1"') ||
      line.includes('python .githooks/ai_commit.py "\$1"') ||
      // also allow single quotes or no quotes (less strict)
      /python\s+\.githooks\/ai_commit\.py\s+"\$1"/.test(line),
  );

  if (!hasCall) {
    return 'Script must contain: python .githooks/ai_commit.py "$1"';
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

  if (selected.includes("__cancel__") || selected.length === 0) {
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

// === CONFIG INTERACTION ===

async function configInteractive() {
  const config = loadConfig();

  const modelLabel = config.model === "llama-3.3-70b-versatile" ? "70B (smarter)" : "8B (faster)";
  const langLabel = LANGUAGES[config.language] || "Русский";
  const mainAction = await promptSelect(
    [
      { name: "✅ Save & exit", value: "exit" },
      { name: "─".repeat(30), value: "__sep__" },
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

  if (mainAction === "model") {
    const inquirer = await import("inquirer");
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
        { name: "⬅️ Back", value: "back" },
      ],
      "Projects & Templates",
    );

    if (ptAction === "list-projects") {
      listProjects();
    } else if (ptAction === "templates") {
      await manageTemplates();
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

  installPythonDeps();

  const githooksDir = join(process.cwd(), ".githooks");
  if (!existsSync(githooksDir)) mkdirSync(githooksDir, { recursive: true });

  for (const file of ["ai_commit.py", "prepare-commit-msg"]) {
    const src = join(SOURCE_GITHOOKS_DIR, file);
    const dst = join(githooksDir, file);
    if (!existsSync(src)) {
      console.error(`❌ Missing: ${src}`);
      process.exit(1);
    }
    const content = readFileSync(src, "utf8");
    if (file === "ai_commit.py") {
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
    if (process.platform === "win32") {
      spawnSync("cmd", ["/c", "rmdir", "/s", "/q", githooks]);
    } else {
      spawnSync("rm", ["-rf", githooks]);
    }
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
  console.log(`🌐 Provider:        Groq (${cfg.apiKey ? "API key configured" : "API key needed — run 'qq config'"})`);
  console.log(
    `📈 Auto-bump:       ${cfg.bumpVersion ? "✅ enabled" : "— disabled"}`,
  );
  console.log(`🎨 Template:        ${templateName}`);
  console.log("");
}

// === FILTER-REPO ===

async function checkFilterRepo() {
  const r = spawnSync("git", ["filter-repo", "--version"], { stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) {
    console.error("❌ git-filter-repo not found. Install it:\n");
    console.error("  pip install git-filter-repo\n");
    console.error("  Or: https://github.com/newren/git-filter-repo");
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
  const { operation } = await inq.default.prompt([
    {
      type: "list",
      name: "operation",
      message: "Select operation:",
      choices: [
        { name: "🗑️  Remove file from history (e.g. .env leaked)", value: "remove-file" },
        { name: "🔑 Replace text in history (e.g. secret key)", value: "replace-text" },
        { name: "📂 Remove entire path from history", value: "remove-path" },
        { name: "⬅️  Back", value: "back" },
      ],
    },
  ]);

  if (operation === "back") return;

  let args = ["filter-repo", "--force"];

  if (operation === "remove-file") {
    const { filePath } = await inq.default.prompt([
      { type: "input", name: "filePath", message: "File path to remove (e.g. .env):" },
    ]);
    if (!filePath.trim()) return;
    args.push("--path", filePath.trim(), "--invert-paths");
  } else if (operation === "replace-text") {
    const { search, replace } = await inq.default.prompt([
      { type: "input", name: "search", message: "Text to find:" },
      { type: "input", name: "replace", message: "Replace with:" },
    ]);
    if (!search.trim()) return;
    args.push("--replace-text", `<${search.trim()}>:${replace.trim()}`);
  } else if (operation === "remove-path") {
    const { dirPath } = await inq.default.prompt([
      { type: "input", name: "dirPath", message: "Directory path to remove (e.g. secrets/):" },
    ]);
    if (!dirPath.trim()) return;
    args.push("--path", dirPath.trim(), "--invert-paths");
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
    return;
  }

  console.log(`\n🔄 Rewriting history...\n`);
  const result = spawnSync("git", args, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error("\n❌ History rewrite failed.");
    process.exit(1);
  }
  console.log(`\n${green}✅ History rewritten successfully.${reset}`);
  console.log(`${dim}Use 'git push --force --all' to update remote.${reset}\n`);
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
  installPythonDeps();

  console.log(`\n${sep(`${bold}📂  Stage Changes${reset}`)}\n`);
  console.log(`${dim}What files to stage?  (default: .)${reset}\n`);

  const rl1 = readline.createInterface({ input: process.stdin, output: process.stdout });
  const addPath = await new Promise((r) =>
    rl1.question(`${dim}git add${reset} `, (a) => { rl1.close(); r(a.trim() || "."); })
  );

  const addResult = spawnSync("git", ["add", addPath], { stdio: "pipe" });
  if (addResult.status !== 0) { console.error("❌ Failed to stage changes."); process.exit(1); }

  const stagedCount = spawnSync("git", ["diff", "--cached", "--numstat"], { encoding: "utf8" })
    .stdout.trim().split("\n").filter(Boolean).length;

  console.log(`${green}✅ ${stagedCount} file(s) staged${reset}\n`);

  // ================================================================
  //  STEP 2 — Generate
  // ================================================================
  showHeader();

  console.log(`\n${sep(`${bold}💬  Generating Commit Message${reset}`)}\n`);
  console.log(`${dim}AI is analyzing your staged changes...${reset}\n`);

  const makeCommit = () => new Promise((resolve) => {
    const child = spawn("git", ["commit", "--quiet"], {
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, GIT_EDITOR: "true" },
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
      const c = await makeCommit();
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
  const { remote, branch } = await inqPush.default.prompt([
    {
      type: "list",
      name: "remote",
      message: "Select remote:",
      choices: remotes.length ? remotes : [{ name: "origin", value: "origin" }],
      default: remotes.includes("origin") ? "origin" : (remotes[0] || "origin"),
    },
    {
      type: "list",
      name: "branch",
      message: "Select branch:",
      choices: allBranches.length ? allBranches : [{ name: "main", value: "main" }],
      default: currentBranch || "main",
    },
  ]);

  console.log(`\n⬆️  Pushing to ${remote}/${branch}...`);
  const push = spawnSync("git", ["push", remote, branch], { stdio: "inherit" });
  if (push.status !== 0) { console.error("\n❌ Push failed"); process.exit(1); }
  console.log(`${green}✅ Pushed successfully${reset}\n`);
}

function showHelp() {
  console.log(`${boldCyan}NeuroCommit${resetColor} is a AI-powered conventional commit messages ${"\x1b[38;5;244m"}(v${pkg.version})${resetColor}

${"\x1b[1m\x1b[37m"}Usage:${resetColor}
  ${boldCyan}qq${resetColor} <command> [options]

${"\x1b[1m\x1b[37m"}Commands:${resetColor}
  ${boldCyan}init${resetColor}          Install AI commit hook
  ${boldCyan}config${resetColor}        Configure model, language, key, prompt, types, co-author & more
  ${boldCyan}go${resetColor}            Start QuickFlow® — interactive commit flow
  ${boldCyan}uninstall${resetColor}     Remove hook
  ${boldCyan}status${resetColor}        Show integration status
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

// === AUTO-UPDATE HOOKS (only for real commands, not flags) ===
if (cmd !== "uninstall" && cmd !== "update") {
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
    case "filter":
      await filterHistory();
      break;
    case "go":
      await quickFlow();
      break;
    case "update":
      console.log("Updating NeuroCommit...\n");
      const upd = spawnSync("npm", ["install", "-g", "@rxgodev/neuro-commit@latest"], { stdio: "inherit", shell: true });
      if (upd.status === 0) {
        console.log("\n✅ NeuroCommit updated successfully.");
      } else {
        console.log("\n❌ Update failed. Try manually:");
        console.log("  npm install -g @rxgodev/neuro-commit@latest");
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
