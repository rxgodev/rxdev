#!/usr/bin/env node
import { spawnSync, spawn } from "child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import { homedir } from "os";
import updateNotifier from "update-notifier";
import { unlinkSync } from "fs";

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
  const RED = "\x1b[31m", GREEN = "\x1b[32m", CYAN = "\x1b[36m", DIM = "\x1b[38;5;244m", RST = "\x1b[0m";

  const lines = [
    `Update available: ${RED}${pkg.version}${RST} → ${GREEN}${update.latest}${RST}`,
    `Run: ${CYAN}qq self-update${RST}`,
    `${DIM}Or: pnpm add -g @rxgodev/neuro-commit@${update.latest}${RST}`,
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

function updateProjectHooks(projectPath) {
  const githooksDir = join(projectPath, ".githooks");
  if (!existsSync(githooksDir)) return false;

  const src = join(SOURCE_GITHOOKS_DIR, "ai_commit.py");
  const dst = join(githooksDir, "ai_commit.py");
  if (!existsSync(src)) return false;

  const latest = readFileSync(src, "utf8");
  if (!existsSync(dst)) {
    writeFileSync(dst, latest);
    return true;
  }

  const current = readFileSync(dst, "utf8");
  if (current !== latest) {
    writeFileSync(dst, latest);
    return true;
  }

  return false;
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
    { type: "list", name: "choice", message, choices: options },
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

  while (true) {
    const mainAction = await promptSelect(
      [
        { name: "📂 Projects & Templates", value: "projects-templates" },
        {
          name: `👥 Co-author: ${config.coauthor ? "enabled" : "disabled"}`,
          value: "coauthor",
        },
        {
          name: `📈 Auto-bump version: ${config.bumpVersion ? "enabled" : "disabled"}`,
          value: "bump",
        },
        {
          name: `🔑 API key: ${config.apiKey ? "configured" : "not set"}`,
          value: "apikey",
        },
        { name: "✅ Save & exit", value: "exit" },
      ],
      "Configuration",
    );

    if (mainAction === "exit") break;

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
          ? "✅ Auto-bump enabled. Smart system auto-discovers manifests across the whole repo\n   (package.json, Cargo.toml, pyproject.toml, pubspec.yaml, Chart.yaml, composer.json,\n   build.gradle, *.csproj, *.gemspec, setup.cfg, VERSION, and more).\n   Preserves pre-release tags, handles monorepos, merges safely with staged files.\n   feat → minor, ! or BREAKING CHANGE → major, anything else → patch.\n"
          : "✅ Auto-bump disabled.\n",
      );
    }

    if (mainAction === "apikey") {
      const inquirer = await import("inquirer");
      const { key } = await inquirer.default.prompt([
        {
          type: "input",
          name: "key",
          message:
            "Enter your API key from https://apifreellm.com/en/api-access:",
          default: config.apiKey || "",
        },
      ]);
      config.apiKey = key.trim();
      saveConfig(config);
      console.log(
        config.apiKey
          ? "✅ API key saved.\n"
          : "ℹ️ API key cleared. Fallback generator will be used.\n",
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
    writeFileSync(dst, readFileSync(src, "utf8"));
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
  console.log(`🌐 Provider:        apifreellm.com (no API key required)`);
  const cfg = loadConfig();
  console.log(
    `📈 Auto-bump:       ${cfg.bumpVersion ? "✅ enabled" : "— disabled"}`,
  );
  console.log(`🎨 Template:        ${templateName}`);
  console.log("");
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

  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

  const dispWidth = (s) => {
    const c = s.replace(/\x1b\[[0-9;]*m/g, "");
    let w = 0;
    for (const ch of c) {
      const cp = ch.codePointAt(0);
      if (cp > 0xffff) w += 2;
      else if (cp >= 0x1100 && cp <= 0x115f) w += 2;
      else if (cp >= 0x2e80 && cp <= 0x9fff) w += 2;
      else if (cp >= 0xa000 && cp <= 0xa4cf) w += 2;
      else if (cp >= 0xac00 && cp <= 0xd7af) w += 2;
      else if (cp >= 0xfe30 && cp <= 0xfe6f) w += 2;
      else if (cp >= 0xff01 && cp <= 0xff60) w += 2;
      else if (cp >= 0x1f000 && cp <= 0x1ffff) w += 2;
      else if (cp >= 0x20000 && cp <= 0x2ffff) w += 2;
      else if (cp >= 0x30000 && cp <= 0x3ffff) w += 2;
      else w += 1;
    }
    return w;
  };

  const clearAndHeader = (lines) => {
    const w = Math.max(...lines.map(dispWidth)) + 4;
    const t = "╭" + "─".repeat(w) + "╮";
    const b = "╰" + "─".repeat(w) + "╯";
    const p = "│" + " ".repeat(w) + "│";
    let o = t + "\n" + p + "\n";
    for (const l of lines) {
      const c = dispWidth(l);
      const L = Math.floor((w - c) / 2);
      o += "│" + " ".repeat(L) + l + " ".repeat(w - c - L) + "│\n";
    }
    o += p + "\n" + b;
    return o;
  };

  const sectionBox = (title, content) => {
    const tLen = dispWidth(title);
    const innerW = Math.max(
      54,
      tLen + 6,
      ...content.map((l) => dispWidth(l) + 4),
    );
    const dash = "─".repeat(Math.max(0, innerW - tLen - 3));
    const top = "╭─ " + title + " " + dash + "╮";
    const bottom = "╰" + "─".repeat(innerW) + "╯";
    const pad = "│" + " ".repeat(innerW) + "│";
    let o = top + "\n" + pad + "\n";
    for (const l of content) {
      const cl = dispWidth(l);
      o += "│  " + l + " ".repeat(Math.max(0, innerW - cl - 2)) + "│\n";
    }
    o += pad + "\n" + bottom;
    return o;
  };

  const contentBox = (content, title) => {
    const rawLines = content.trimEnd().split("\n");
    const maxContentW = rawLines.length > 0
      ? Math.max(...rawLines.map(dispWidth))
      : 0;
    const cols = (process.stdout.columns || 100) - 6;
    const w = Math.max(Math.min(maxContentW + 4, Math.min(cols, 100)), 30);
    const innerW = w - 4;

    const lines = [];
    for (const line of rawLines) {
      if (dispWidth(line) > innerW && innerW > 20) {
        for (let i = 0; i < line.length; i += innerW) {
          lines.push(line.slice(i, i + innerW));
        }
      } else {
        lines.push(line);
      }
    }

    const tb = "─".repeat(w);
    const pad = "│" + " ".repeat(w) + "│";
    let o;
    if (title) {
      const tLen = dispWidth(title);
      const dash = "─".repeat(Math.max(0, w - tLen - 3));
      o = "╭─ " + title + " " + dash + "╮\n";
    } else {
      o = "╭" + tb + "╮\n";
    }
    o += pad + "\n";
    for (const l of lines) {
      const cl = dispWidth(l);
      o += "│  " + l + " ".repeat(Math.max(0, w - cl - 2)) + "│\n";
    }
    o += pad + "\n╰" + tb + "╯";
    return o;
  };

  const showCommitReview = () => {
    process.stdout.write("\x1b[2J\x1b[H");
    console.log(clearAndHeader([`${bold}🚀 NeuroCommit QuickFlow®${reset}`]));
    console.log(`\n${contentBox(currentMessage, `${bold}📄 Commit Message${reset}`)}\n`);
  };

  const nextStep = () => {
    process.stdout.write("\x1b[2J\x1b[H");
    console.log(clearAndHeader([`${bold}🚀 NeuroCommit QuickFlow®${reset}`]));
  };

  // ================================================================
  //  STEP 1 — Stage
  // ================================================================
  nextStep();
  installPythonDeps();

  const inq = await import("inquirer");

  const stageHeading = `  ${bold}📂 Stage Changes${reset}\n  ${dim}What files to stage?${reset}\n`;

  process.stdout.write(`\n${stageHeading}`);

  const { addPath } = await inq.default.prompt([{
    type: "input",
    name: "addPath",
    message: "git add",
    default: ".",
    prefix: "",
    transformer: (i) => dim + i + reset,
  }]);

  const addResult = spawnSync("git", ["add", addPath], { stdio: "pipe" });
  if (addResult.status !== 0) {
    console.error(`  ❌ Failed to stage changes.`);
    process.exit(1);
  }

  const stagedCount = spawnSync(
    "git", ["diff", "--cached", "--numstat"],
    { encoding: "utf8" },
  ).stdout.trim().split("\n").filter(Boolean).length;

  console.log(`  ${green}✅ ${stagedCount} file(s) staged${reset}\n`);

  // ================================================================
  //  STEP 2 — Commit Message
  // ================================================================

  const makeCommit = () => {
    return new Promise((resolve) => {
      const child = spawn("git", ["commit", "--quiet"], {
        stdio: "inherit",
        env: { ...process.env, GIT_EDITOR: "true" },
      });
      const onInt = () => { child.kill(); };
      process.on("SIGINT", onInt);
      child.on("close", (code) => {
        process.removeListener("SIGINT", onInt);
        resolve(code);
      });
    });
  };

  const makeSummary = () => {
    const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim();
    const hash = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim();
    const stat = spawnSync(
      "git",
      ["diff-tree", "--no-commit-id", "-r", "--shortstat", "HEAD"],
      { encoding: "utf8" },
    ).stdout.trim();
    return `${cyan}${bold}[${branch}: ${hash}]${reset} ${stat}`;
  };

  nextStep();

  console.log(`\n${sectionBox(`${bold}💬 Generating Commit Message${reset}`, [
    `${dim}AI is analyzing your staged changes...${reset}`,
  ])}`);

  let commitResultCode = await makeCommit();

  if (commitResultCode === null) {
    console.log(`\n  ↪️  Cancelled`);
    process.exit(130);
  }

  if (commitResultCode !== 0) {
    console.error(`\n  ❌ Failed to generate commit message`);
    process.exit(1);
  }

  const commitMsgFile = join(process.cwd(), ".git", "COMMIT_EDITMSG");
  let currentMessage = readFileSync(commitMsgFile, "utf8").trim();

  currentMessage = currentMessage
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .trim();

  if (!currentMessage) {
    console.error("\n  ❌ Empty commit message");
    process.exit(1);
  }

  // ================================================================
  //  LOOP — Review / Edit / Regenerate / Cancel
  // ================================================================
  showCommitReview();

  while (true) {
    const { action } = await inq.default.prompt([
      {
        type: "list",
        name: "action",
        message: "What next?",
        choices: [
          { name: `${green}✅  Push${reset}`, value: "push" },
          { name: `${cyan}✏️   Edit message${reset}`, value: "edit" },
          { name: `${yellow}🔄  Regenerate${reset}`, value: "regenerate" },
          { name: `${bold}❌  Cancel${reset}`, value: "cancel" },
        ],
        default: "push",
      },
    ]);

    if (action === "push") {
      break;
    }

    if (action === "cancel") {
      spawnSync("git", ["reset", "--soft", "HEAD~1"], { stdio: "pipe" });
      console.log(`\n${bold}↩️  Commit cancelled${reset}`);
      return;
    }

    if (action === "edit") {
      writeFileSync(commitMsgFile, currentMessage, "utf8");
      const editor =
        process.env.GIT_EDITOR ||
        process.env.VISUAL ||
        process.env.EDITOR ||
        "vi";
      const editRes = spawnSync(`${editor} "${commitMsgFile}"`, {
        stdio: "inherit",
        shell: true,
      });
      if (editRes.status !== 0) {
        console.log(
          `\n${yellow}↩️  Edit cancelled, keeping previous message${reset}`,
        );
        continue;
      }
      const edited = readFileSync(commitMsgFile, "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n")
        .trim();
      if (!edited) {
        console.log(`\n${yellow}❌ Empty message, keeping previous${reset}`);
        continue;
      }
      writeFileSync(commitMsgFile, edited, "utf8");
      const amend = spawnSync(
        "git",
        ["commit", "--amend", "-F", commitMsgFile],
        {
          stdio: "inherit",
          env: { ...process.env, GIT_EDITOR: "true" },
        },
      );
      if (amend.status !== 0) {
        console.error(`\n  ❌ Amend failed`);
        process.exit(1);
      }
      currentMessage = edited;
      showCommitReview();
    }

    if (action === "regenerate") {
      spawnSync("git", ["reset", "--soft", "HEAD~1"], { stdio: "pipe" });

      nextStep();

      console.log(`\n${sectionBox(`${bold}💬 Regenerating Commit Message${reset}`, [
        `${dim}AI is re-analyzing your changes...${reset}`,
      ])}`);

      commitResultCode = await makeCommit();
      if (commitResultCode === null) {
        console.log(`\n  ↪️  Cancelled`);
        process.exit(130);
      }
      if (commitResultCode !== 0) {
        console.error(`\n  ❌ Failed to regenerate`);
        process.exit(1);
      }
      currentMessage = readFileSync(commitMsgFile, "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n")
        .trim();
      if (!currentMessage) {
        console.error("\n  ❌ Empty message after regeneration");
        process.exit(1);
      }
      showCommitReview();
    }
  }

  // ================================================================
  //  STEP 3 — Push
  // ================================================================
  nextStep();

  process.stdout.write(`\n  ${bold}⬆️  Push Changes${reset}\n  ${dim}Specify remote and branch${reset}\n\n`);

  const { pushDest } = await inq.default.prompt([{
    type: "input",
    name: "pushDest",
    message: "git push",
    default: "origin main",
    prefix: "",
    transformer: (i) => dim + i + reset,
  }]);

  console.log(`\n  ⬆️  Pushing...`);
  const pushArgs = ["push", ...pushDest.split(/\s+/)];
  const push = spawnSync("git", pushArgs, { stdio: "inherit" });

  if (push.status !== 0) {
    console.error(`\n  ❌ Push failed`);
    process.exit(1);
  }
  console.log(`  ${green}✅ Pushed successfully${reset}\n`);
}

async function selfUpdate() {
  const GREEN = "\x1b[32m";
  const CYAN = "\x1b[36m";
  const DIM = "\x1b[38;5;244m";
  const RST = "\x1b[0m";

  if (!update || update.latest === pkg.version) {
    console.log(`  ${GREEN}✅ Already up-to-date (v${pkg.version})${RST}`);
    return;
  }

  console.log(`\n  Updating ${DIM}v${pkg.version}${RST} → ${GREEN}v${update.latest}${RST}...\n`);

  const pm = process.env.npm_config_user_agent?.includes("pnpm")
    ? "pnpm"
    : "npm";

  const result = spawnSync(pm, [
    "add", "-g", `@rxgodev/neuro-commit@${update.latest}`,
  ], { stdio: "inherit" });

  if (result.status !== 0) {
    console.error(`\n  ❌ Update failed. Try manually:\n     ${pm} add -g @rxgodev/neuro-commit@${update.latest}`);
    process.exit(1);
  }

  console.log(`  ${GREEN}✅ Updated to v${update.latest}${RST}\n`);
}

function showHelp() {
  console.log(`${boldCyan}NeuroCommit${resetColor} is a AI-powered conventional commit messages ${"\x1b[38;5;244m"}(v${pkg.version})${resetColor}

${"\x1b[1m\x1b[37m"}Usage:${resetColor}
  ${boldCyan}qq${resetColor} <command> [options]

${"\x1b[1m\x1b[37m"}Commands:${resetColor}
  ${boldCyan}init${resetColor}          Install AI commit hook
  ${boldCyan}config${resetColor}        Configure key, models, co-author, projects & templates
  ${boldCyan}go${resetColor}            Start QuickFlow® — interactive commit flow
  ${boldCyan}uninstall${resetColor}     Remove hook
  ${boldCyan}status${resetColor}        Show integration status
  ${boldCyan}retry${resetColor}         Revert last commit and regenerate message
  ${boldCyan}self-update${resetColor}   Update NeuroCommit to the latest version

${"\x1b[1m\x1b[37m"}Options:${resetColor}
  ${boldCyan}-v, --version${resetColor}   Show version
  ${boldCyan}-h, --help${resetColor}      Show this help`);
}

const args = process.argv.slice(2);

// Handle global flags first
if (args.includes("--version") || args.includes("-v")) {
  console.log(`v${pkg.version}`);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  showHelp();
  process.exit(0);
}

const cmd = args[0];

// === AUTO-UPDATE HOOKS (only for real commands, not flags) ===
if (cmd !== "uninstall") {
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
switch (cmd) {
  case "init":
    install();
    break;
  case "config":
    configInteractive();
    break;
  case "uninstall":
    uninstall();
    break;
  case "status":
    showStatus();
    break;
  case "retry":
    retryLastCommit();
    break;
  case "go":
    quickFlow();
    break;
  case "self-update":
    selfUpdate();
    break;
  default:
    showHelp();
}
