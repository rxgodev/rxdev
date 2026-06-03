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

  const sa = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

  const clearScreen = () => process.stdout.write("\x1b[2J\x1b[H");

  // ── Box renderer with live-update support ──
  let _boxH = 0;
  const box = (lines) => {
    if (_boxH) process.stdout.write(`\x1b[${_boxH}A`);
    const w = Math.max(...lines.map((l) => sa(l).length)) + 4;
    const t = "╭" + "─".repeat(w) + "╮";
    const b = "╰" + "─".repeat(w) + "╯";
    const p = "│" + " ".repeat(w) + "│";
    let o = t + "\n" + p + "\n";
    for (const l of lines) {
      const c = sa(l).length;
      const L = Math.floor((w - c) / 2);
      o += "│" + " ".repeat(L) + l + " ".repeat(w - c - L) + "│\n";
    }
    o += p + "\n" + b;
    _boxH = lines.length + 4;
    process.stdout.write(o);
  };

  const showHeader = () => {
    clearScreen();
    box([`${bold}🚀 NeuroCommit QuickFlow®${reset}`]);
    _boxH = 0;
  };

  // ── Single-line raw input via readline ──
  const readRaw = () => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question("", (ans) => { rl.close(); resolve(ans); });
  });

  // ── Helper: draw a "live box" up to the input line, read, then close ──
  const boxWithInput = async (content, promptLabel, defaultValue) => {
    const w = Math.max(...content.map((l) => sa(l).length)) + 4;
    const top = "╭" + "─".repeat(w) + "╮";
    const bot = "╰" + "─".repeat(w) + "╯";
    const pad = "│" + " ".repeat(w) + "│";

    process.stdout.write(top + "\n" + pad + "\n");
    for (const l of content) {
      const c = sa(l).length;
      const L = Math.floor((w - c) / 2);
      process.stdout.write("│" + " ".repeat(L) + l + " ".repeat(w - c - L) + "│\n");
    }
    process.stdout.write(pad + "\n");

    // Input line (readline adds \n after Enter, so move back up)
    const prefix = `  ${dim}${promptLabel}${reset} `;
    process.stdout.write(`│${prefix}`);
    const ans = await readRaw();
    process.stdout.write("\x1b[1A"); // move up — readline advanced one line
    const used = 1 + sa(prefix + ans).length;
    process.stdout.write(" ".repeat(Math.max(0, w + 2 - used - 1)) + "│\n");

    process.stdout.write(pad + "\n" + bot + "\n");
    return ans.trim() || defaultValue;
  };

  // ================================================================
  //  STEP 1 — Stage
  // ================================================================
  showHeader();
  installPythonDeps();

  const addPath = await boxWithInput(
    [
      `  ${bold}📂 Stage Changes${reset}`,
      "",
      `  ${dim}What files to stage?${reset}`,
      "",
    ],
    "git add",
    ".",
  );

  const addResult = spawnSync("git", ["add", addPath], { stdio: "pipe" });
  if (addResult.status !== 0) { console.error("  ❌ Failed to stage changes."); process.exit(1); }

  const stagedCount = spawnSync("git", ["diff", "--cached", "--numstat"], { encoding: "utf8" })
    .stdout.trim().split("\n").filter(Boolean).length;

  console.log(`  ${green}✅ ${stagedCount} file(s) staged${reset}\n`);

  // ================================================================
  //  STEP 2 — Generate
  // ================================================================
  showHeader();

  const genStatic = [
    `  ${bold}💬 Generating Commit Message${reset}`,
    "",
    `  ${dim}AI is analyzing your staged changes...${reset}`,
  ];

  // Capture child output live inside the box
  const makeCommit = () => new Promise((resolve) => {
    const child = spawn("git", ["commit", "--quiet"], {
      stdio: ["inherit", "pipe", "inherit"],
      env: { ...process.env, GIT_EDITOR: "true" },
    });

    let outBuf = "";
    let tick = null;

    const render = () => {
      const cleaned = outBuf.replace(/\r$/, "").split("\n").map((l) => {
        const idx = l.lastIndexOf("\r");
        return idx >= 0 ? l.slice(idx + 1) : l;
      }).filter(Boolean);

      const maxLog = 6;
      if (cleaned.length > maxLog) cleaned.splice(0, cleaned.length - maxLog);

      const all = [...genStatic, "", ...cleaned.map((l) => `  ${dim}${l}${reset}`)];
      box(all);
    };

    child.stdout.on("data", (d) => {
      outBuf += d.toString();
      if (outBuf.length > 20000) { const p = outBuf.split("\n"); outBuf = p.slice(-30).join("\n"); }
      if (tick) clearTimeout(tick);
      tick = setTimeout(render, 60);
    });

    process.on("SIGINT", () => child.kill());

    child.on("close", (code) => {
      if (tick) clearTimeout(tick);
      render();
      _boxH = 0;
      resolve(code);
    });
  });

  const commitCode = await makeCommit();
  console.log("");
  if (commitCode === null) { process.exit(130); }
  if (commitCode !== 0) { console.error("  ❌ Failed to generate commit message"); process.exit(1); }

  const commitMsgFile = join(process.cwd(), ".git", "COMMIT_EDITMSG");
  let currentMessage = readFileSync(commitMsgFile, "utf8").trim()
    .split("\n").filter((l) => !l.trim().startsWith("#")).join("\n").trim();

  if (!currentMessage) { console.error("  ❌ Empty commit message"); process.exit(1); }

  // ================================================================
  //  REVIEW LOOP
  // ================================================================
  const inq = await import("inquirer");

  const showReview = () => {
    clearScreen();
    box([`${bold}🚀 NeuroCommit QuickFlow®${reset}`]);
    _boxH = 0;
    console.log("");

    const raw = currentMessage.trimEnd().split("\n");
    const maxW = Math.max(...raw.map((l) => sa(l).length));
    const cols = (process.stdout.columns || 100) - 6;
    const innerW = Math.max(Math.min(maxW, Math.min(cols - 4, 96)), 26);
    const wrapped = [];
    for (const line of raw) {
      if (sa(line).length > innerW && innerW > 20) {
        for (let i = 0; i < line.length; i += innerW) wrapped.push(line.slice(i, i + innerW));
      } else wrapped.push(line);
    }

    const all = [`  ${bold}📄 Commit Message${reset}`, "", ...wrapped, ""];
    const boxW = Math.max(...all.map((l) => sa(l).length)) + 4;
    const t = "╭" + "─".repeat(boxW) + "╮";
    const b = "╰" + "─".repeat(boxW) + "╯";
    const p = "│" + " ".repeat(boxW) + "│";
    let o = t + "\n" + p + "\n";
    for (const l of all) {
      const c = sa(l).length;
      const L = Math.floor((boxW - c) / 2);
      o += "│" + " ".repeat(L) + l + " ".repeat(boxW - c - L) + "│\n";
    }
    o += p + "\n" + b;
    console.log(o);
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
      const editor = process.env.GIT_EDITOR || process.env.VISUAL || process.env.EDITOR || "vi";
      const editRes = spawnSync(`"${editor}" "${commitMsgFile}"`, { stdio: "inherit", shell: true });
      if (editRes.status !== 0) { console.log(`\n${yellow}↩️  Edit cancelled${reset}`); continue; }
      const edited = readFileSync(commitMsgFile, "utf8").trim()
        .split("\n").filter((l) => !l.trim().startsWith("#")).join("\n").trim();
      if (!edited) { console.log(`\n${yellow}❌ Empty message${reset}`); continue; }
      writeFileSync(commitMsgFile, edited, "utf8");
      const amend = spawnSync("git", ["commit", "--amend", "-F", commitMsgFile], {
        stdio: "inherit", env: { ...process.env, GIT_EDITOR: "true" },
      });
      if (amend.status !== 0) { console.error("  ❌ Amend failed"); process.exit(1); }
      currentMessage = edited;
      showReview();
    }

    if (action === "regenerate") {
      spawnSync("git", ["reset", "--soft", "HEAD~1"], { stdio: "pipe" });
      showHeader();
      const c = await makeCommit();
      console.log("");
      if (c === null) { process.exit(130); }
      if (c !== 0) { console.error("  ❌ Failed to regenerate"); process.exit(1); }
      currentMessage = readFileSync(commitMsgFile, "utf8").trim()
        .split("\n").filter((l) => !l.trim().startsWith("#")).join("\n").trim();
      if (!currentMessage) { console.error("  ❌ Empty message"); process.exit(1); }
      showReview();
    }
  }

  // ================================================================
  //  STEP 3 — Push
  // ================================================================
  showHeader();

  const pushDest = await boxWithInput(
    [
      `  ${bold}⬆️  Push Changes${reset}`,
      "",
      `  ${dim}Specify remote and branch${reset}`,
      "",
    ],
    "git push",
    "origin main",
  );

  console.log(`  ⬆️  Pushing...`);
  const push = spawnSync("git", ["push", ...pushDest.split(/\s+/)], { stdio: "inherit" });
  if (push.status !== 0) { console.error("\n  ❌ Push failed"); process.exit(1); }
  console.log(`  ${green}✅ Pushed successfully${reset}\n`);
}

async function selfUpdate() {
  const GREEN = "\x1b[32m";
  const DIM = "\x1b[38;5;244m";
  const RST = "\x1b[0m";

  if (!update || update.latest === pkg.version) {
    console.log(`  ${GREEN}✅ Already up-to-date (v${pkg.version})${RST}`);
    return;
  }

  console.log(`\n  Updating ${DIM}v${pkg.version}${RST} → ${GREEN}v${update.latest}${RST}...\n`);

  const pmList = [
    { cmd: "pnpm", args: ["add", "-g"] },
    { cmd: "yarn", args: ["global", "add"] },
    { cmd: "npm", args: ["install", "-g"] },
  ];

  // Prefer the package manager that was used to invoke the current command
  const ua = process.env.npm_config_user_agent || "";
  let preferred = pmList.find((p) => ua.includes(p.cmd));
  if (preferred) {
    pmList.unshift(pmList.splice(pmList.indexOf(preferred), 1)[0]);
  }

  let lastErr = null;
  for (const pm of pmList) {
    const which = spawnSync(
      process.platform === "win32" ? "where" : "which",
      [pm.cmd],
      { stdio: "pipe" },
    );
    if (which.status !== 0) continue;

    const result = spawnSync(pm.cmd, [...pm.args, `@rxgodev/neuro-commit@${update.latest}`], { stdio: "inherit" });
    if (result.status === 0) {
      console.log(`  ${GREEN}✅ Updated to v${update.latest}${RST}\n`);
      return;
    }
    lastErr = result;
  }

  console.error(`\n  ❌ All package managers failed. Try manually:\n`);
  for (const pm of pmList) {
    const which = spawnSync(
      process.platform === "win32" ? "where" : "which",
      [pm.cmd],
      { stdio: "pipe" },
    );
    if (which.status === 0) {
      console.error(`     ${pm.cmd} ${pm.args.join(" ")} @rxgodev/neuro-commit@${update.latest}`);
    }
  }
  console.error("");
  process.exit(1);
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
