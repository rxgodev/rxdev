#!/usr/bin/env node
import { spawnSync, spawn } from "child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import { homedir } from "os";
import updateNotifier from "update-notifier";

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
  const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, "");

  const lines = [
    `Update available! ${"\x1b[31m"}${pkg.version}${"\x1b[0m"} → ${"\x1b[32m"}${update.latest}${"\x1b[0m"}.`,
    `To update, run: ${"\x1b[36m"}pnpm add -g @rxgodev/neuro-commit@${update.latest}${"\x1b[0m"}`,
  ];

  const maxWidth = Math.max(...lines.map((l) => stripAnsi(l).length)) + 8;
  const top = "   ╭" + "─".repeat(maxWidth) + "╮";
  const bottom = "   ╰" + "─".repeat(maxWidth) + "╯";
  const padding = "   │" + " ".repeat(maxWidth) + "│";

  let output = `\n${top}\n${padding}\n`;
  for (const line of lines) {
    const cleanLen = stripAnsi(line).length;
    const left = Math.floor((maxWidth - cleanLen) / 2);
    const right = maxWidth - cleanLen - left;
    output += `   │${" ".repeat(left)}${line}${" ".repeat(right)}│\n`;
  }
  console.log(`${output}${padding}\n${bottom}\n`);
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
const ENV_FILE = join(CONFIG_DIR, ".env");

ensureSecureKeyStorage();

const SMART_TO_SIMPLE_MODELS = [
  "deepseek-ai/DeepSeek-R1-0528",
  "mistralai/Devstral-Small-2505",
  "meta-llama/Llama-3.3-70B-Instruct",
  "mistralai/Magistral-Small-2506",
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
  "Qwen3-235B-A22B-Thinking-2507",
];

const DEFAULT_CONFIG = {
  coauthor: true,
  modelQueue: [...SMART_TO_SIMPLE_MODELS],
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

function loadKeyFromEnvFile() {
  try {
    if (existsSync(ENV_FILE)) {
      const content = readFileSync(ENV_FILE, "utf8");
      const match = content.match(/^OPENAI_API_KEY\s*=\s*(.+)$/m);
      if (match) {
        return match[1].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch (e) {
    console.warn("⚠️ Failed to read .env file");
  }
  return null;
}

function migrateKeyFromShellToEnv() {
  const home = homedir();
  if (!home) return null;

  const rcFile = (process.env.SHELL || "/bin/bash").includes("zsh")
    ? join(home, ".zshrc")
    : join(home, ".bashrc");

  if (!existsSync(rcFile)) return null;

  try {
    let content = readFileSync(rcFile, "utf8");
    const match = content.match(/export OPENAI_API_KEY=["']?(.+?)["']?$/m);
    if (match) {
      const key = match[1];
      ensureConfigDir();
      writeFileSync(ENV_FILE, `OPENAI_API_KEY="${key}"\n`, { mode: 0o600 });
      content =
        content
          .replace(/export OPENAI_API_KEY=["']?.*?["']?\s*$/m, "")
          .trimEnd() + "\n";
      writeFileSync(rcFile, content);
      console.log(`🔒 Migrated API key from ${rcFile} to ${ENV_FILE}`);
      return key;
    }
  } catch (e) {
    console.warn("⚠️ Failed to migrate API key from shell config");
  }
  return null;
}

function checkExistingKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;

  const fromEnvFile = loadKeyFromEnvFile();
  if (fromEnvFile) return fromEnvFile;

  const migrated = migrateKeyFromShellToEnv();
  if (migrated) return migrated;

  return null;
}

async function saveKeyToEnv(key) {
  ensureConfigDir();
  const envContent = `OPENAI_API_KEY="${key}"\n`;
  writeFileSync(ENV_FILE, envContent, { mode: 0o600 });
  process.env.OPENAI_API_KEY = key;

  try {
    const home = homedir();
    if (home) {
      const rcFile = (process.env.SHELL || "/bin/bash").includes("zsh")
        ? join(home, ".zshrc")
        : join(home, ".bashrc");
      if (existsSync(rcFile)) {
        let content = readFileSync(rcFile, "utf8");
        const regex = /export OPENAI_API_KEY=["']?.*?["']?\s*$/m;
        if (regex.test(content)) {
          content = content.replace(regex, "").trimEnd() + "\n";
          writeFileSync(rcFile, content);
          console.log(`🧹 Removed API key from ${rcFile}`);
        }
      }
    }
  } catch (e) {}

  console.log(`✅ API key saved securely to ${ENV_FILE}`);
}

function ensureSecureKeyStorage() {
  if (existsSync(ENV_FILE)) return;

  const key = process.env.OPENAI_API_KEY || migrateKeyFromShellToEnv();

  if (key) {
    ensureConfigDir();
    const envContent = `OPENAI_API_KEY="${key}"\n`;
    writeFileSync(ENV_FILE, envContent, { mode: 0o600 });
    process.env.OPENAI_API_KEY = key;
    console.log(`🔒 API key secured to ${ENV_FILE}`);
  }
}

function loadTokenUsage() {
  const usageFile = join(CONFIG_DIR, "token_usage.json");
  try {
    if (existsSync(usageFile)) {
      const data = JSON.parse(readFileSync(usageFile, "utf8"));
      const today = new Date().toISOString().split("T")[0];
      if (data.date === today) {
        return data.models || {};
      }
    }
  } catch (e) {
    console.warn("⚠️ Failed to load token usage");
  }
  return {};
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

  const filesToUpdate = ["ai_commit.py"];
  let updated = false;
  for (const file of filesToUpdate) {
    const src = join(SOURCE_GITHOOKS_DIR, file);
    const dst = join(githooksDir, file);
    if (existsSync(src)) {
      const current = existsSync(dst) ? readFileSync(dst, "utf8") : "";
      const latest = readFileSync(src, "utf8");
      if (current !== latest) {
        writeFileSync(dst, latest);
        updated = true;
      }
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
  console.log("📦 Installing Python dependencies...");
  const cmd = [checkPython(), "-m", "pip", "install", "--quiet", "pathspec"];
  if (spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" }).status !== 0) {
    console.error("❌ Failed to install Python dependencies.");
    process.exit(1);
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

async function askForKey() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question("Enter your OPENAI_API_KEY: ", (key) => {
      rl.close();
      resolve(key.trim());
    });
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
        { name: "🔑 API Key", value: "key" },
        { name: "🧠 Models", value: "models" },
        { name: "📂 Projects & Templates", value: "projects-templates" },
        {
          name: `👥 Co-author: ${config.coauthor ? "enabled" : "disabled"}`,
          value: "coauthor",
        },
        { name: "✅ Save & exit", value: "exit" },
      ],
      "Configuration",
    );

    if (mainAction === "exit") break;

    if (mainAction === "key") {
      const keyAction = await promptSelect(
        [
          { name: "👁️ View current key", value: "view" },
          { name: "✏️ Edit key", value: "edit" },
          { name: "⬅️ Back", value: "back" },
        ],
        "API Key",
      );

      if (keyAction === "view") {
        const current = checkExistingKey();
        if (current) {
          console.log(
            `\n🔑 Current: ${current.substring(0, 6)}...${current.slice(-4)}\n`,
          );
        } else {
          console.log("\n❌ No API key found.\n");
        }
      } else if (keyAction === "edit") {
        const key = await askForKey();
        await saveKeyToEnv(key);
        console.log("✅ Key updated.\n");
      }
    }

    if (mainAction === "models") {
      const modelAction = await promptSelect(
        [
          { name: "📊 Show models & token usage", value: "limits" },
          { name: "⚙️ Set primary model", value: "set" },
          { name: "📋 Show current queue", value: "queue" },
          { name: "⬅️ Back", value: "back" },
        ],
        "Models",
      );

      if (modelAction === "limits") {
        const usage = loadTokenUsage();
        const today = new Date().toISOString().split("T")[0];
        const DAILY_QUOTA = 500_000;

        console.log(
          `\n📊 Token usage for ${today} (quota: ${DAILY_QUOTA.toLocaleString()} tokens)\n`,
        );

        const allModels = [
          ...new Set([...config.modelQueue, ...SMART_TO_SIMPLE_MODELS]),
        ];
        const rows = allModels.map((model) => {
          const used = usage[model] || 0;
          const remaining = Math.max(0, DAILY_QUOTA - used);
          const pct = ((used / DAILY_QUOTA) * 100).toFixed(1);
          return {
            Model: model,
            Used: used.toLocaleString(),
            Remaining: remaining.toLocaleString(),
            "%": pct,
          };
        });

        rows.sort((a, b) => parseFloat(b["%"]) - parseFloat(a["%"]));
        console.table(rows);
        console.log("");
      }

      if (modelAction === "queue") {
        console.log("\n📋 Current model queue:");
        config.modelQueue.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
        console.log("");
      }

      if (modelAction === "set") {
        const primary = await promptSelect(
          SMART_TO_SIMPLE_MODELS.map((m) => ({ name: m, value: m })),
          "Select primary model:",
        );
        const idx = SMART_TO_SIMPLE_MODELS.indexOf(primary);
        config.modelQueue = [primary, ...SMART_TO_SIMPLE_MODELS.slice(idx + 1)];
        saveConfig(config);
        console.log("\n✅ Queue updated. New order:");
        config.modelQueue.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
        console.log("");
      }
    }

    if (mainAction === "coauthor") {
      config.coauthor = !config.coauthor;
      saveConfig(config);
      console.log(
        config.coauthor
          ? "✅ Co-author enabled.\n"
          : "✅ Co-author disabled.\n",
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
  const key = checkExistingKey() || (await askForKey());
  await saveKeyToEnv(key);

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

  console.log("🎉 Auto-commit installed successfully!");
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
  console.log("🗑️ Auto-commit uninstalled!");
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

  const hasApiKey = !!checkExistingKey();

  const templateName = getTemplateForProject(root) || "—";

  const config = loadConfig();
  const firstModel = config.modelQueue[0] || "—";
  let quotaInfo = "—";
  if (firstModel !== "—") {
    const usage = loadTokenUsage();
    const used = usage[firstModel] || 0;
    const remaining = Math.max(0, 500_000 - used);
    quotaInfo = `${remaining.toLocaleString()} tokens`;
  }

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
  console.log(`🔑 API key:         ${hasApiKey ? "✅ found" : "❌ not found"}`);
  console.log(`🎨 Template:        ${templateName}`);
  console.log(`📊 Quota (next):    ${quotaInfo}`);
  console.log("");
}

// === AUTO-UPDATE HOOKS ===

const cmd = process.argv[2];
if (!["uninstall"].includes(cmd)) {
  const projects = getManagedProjects().filter((p) => existsSync(p));
  let updatedCount = 0;
  for (const proj of projects) {
    if (updateProjectHooks(proj)) updatedCount++;
  }
  if (updatedCount > 0) {
    console.log(`\n🔄 Updated AI hooks in ${updatedCount} project(s).\n`);
  }
}

// === MAIN ===

const boldCyan = "\x1b[1m\x1b[38;2;57;186;229m";
const resetColor = "\x1b[0m";

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
  default:
    // \x1b[1m - bold
    console.log(`${boldCyan}NeuroCommit ${resetColor}is a powerful AI command-line CLI for creating comments on your commits. ${"\x1b[38;5;16m"}(v${pkg.version})${resetColor}

${"\x1b[1m\x1b[37m"}Usage: qq <command>${resetColor}

${"\x1b[1m\x1b[37m"}Commands:${resetColor}
  ${boldCyan}init${resetColor}          Install AI commit hook
  ${boldCyan}config${resetColor}        Configure key, models, co-author, projects & templates
  ${boldCyan}uninstall${resetColor}     Remove hook`);
}
