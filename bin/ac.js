#!/usr/bin/env node
import { spawnSync } from "child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import { homedir } from "os";

import updateNotifier from "update-notifier";
import pkg from "../package.json" assert { type: "json" };

const update = updateNotifier({
  pkg,
  updateCheckInterval: 0,
}).update;

if (update?.latest && update.latest !== pkg.version) {
  const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, "");

  const lines = [
    `Update available! ${"\x1b[31m"}${pkg.version}${"\x1b[0m"} → ${"\x1b[32m"}${update.latest}${"\x1b[0m"}.`,
    // `${"\x1b[34m"}Changelog: ${"\x1b[0m"}https://github.com/rxgodev/neuro-commit/releases/latest`,
    `To update, run: ${"\x1b[34m"}pnpm add -g @rxgodev/neuro-commit@${update.latest}${"\x1b[0m"}`,
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SOURCE_GITHOOKS_DIR = join(__dirname, "../.githooks");

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

const SMART_TO_SIMPLE_MODELS = [
  "meta-llama/Llama-3.3-70B-Instruct",
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
  "deepseek-ai/DeepSeek-R1-0528",
  "mistralai/Magistral-Small-2506",
  "mistralai/Devstral-Small-2505",
  "google/gemma-3-270m-it",
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
  const cmd = [
    checkPython(),
    "-m",
    "pip",
    "install",
    "--quiet",
    "httpx",
    "pathspec",
  ];
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

function checkExistingKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const home = homedir();
  if (home) {
    const rcFile = (process.env.SHELL || "/bin/bash").includes("zsh")
      ? join(home, ".zshrc")
      : join(home, ".bashrc");
    if (existsSync(rcFile)) {
      const match = readFileSync(rcFile, "utf8").match(
        /export OPENAI_API_KEY="(.+)"/,
      );
      if (match) return match[1];
    }
  }
  return null;
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

async function saveKeyToEnv(key) {
  process.env.OPENAI_API_KEY = key;
  if (process.platform === "win32") {
    try {
      const { execSync } = await import("child_process");
      execSync(`setx OPENAI_API_KEY "${key}"`, { stdio: "pipe" });
      console.log("✅ Saved to Windows environment.");
      console.log("👉 Restart terminal to apply.");
      return;
    } catch {}
  } else {
    const home = homedir();
    if (home) {
      const rcFile = (process.env.SHELL || "/bin/bash").includes("zsh")
        ? join(home, ".zshrc")
        : join(home, ".bashrc");
      if (existsSync(rcFile)) {
        let content = readFileSync(rcFile, "utf8");
        const line = `export OPENAI_API_KEY="${key}"`;
        const regex = /export OPENAI_API_KEY=".*"/;
        content = regex.test(content)
          ? content.replace(regex, line)
          : content + `\n${line}\n`;
        writeFileSync(rcFile, content);
        console.log(`✅ Updated ${rcFile}`);
        return;
      }
    }
  }
  console.log("⚠️ Key saved only for current session.");
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

// === CONFIG INTERACTION ===

async function promptSelect(options, message) {
  const inquirer = await import("inquirer");
  const { choice } = await inquirer.default.prompt([
    { type: "list", name: "choice", message, choices: options },
  ]);
  return choice;
}

async function configInteractive() {
  const config = loadConfig();

  while (true) {
    const mainAction = await promptSelect(
      [
        { name: "🔑 API Key", value: "key" },
        { name: "🧠 Models", value: "models" },
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

  await addToGitignore(); // ← НОВОЕ

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

  if (valid.length > 0) {
    valid.forEach((p) => {
      const name = p.split(/[\\/]/).pop();
      console.log(`  ✅ ${name}`);
      console.log(`     ${p}`);
    });
  }

  if (invalid.length > 0) {
    console.log(
      '\n  ⚠️  Missing projects (run "qq uninstall" in them to clean up):',
    );
    invalid.forEach((p) => {
      const name = p.split(/[\\/]/).pop();
      console.log(`     ❌ ${name} → ${p}`);
    });
  }
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
  case "projects":
    if (process.argv[3] === "--update") {
      const projects = getManagedProjects().filter((p) => existsSync(p));
      let count = 0;
      for (const proj of projects) {
        if (updateProjectHooks(proj)) count++;
      }
      console.log(`\n✅ Updated hooks in ${count} project(s).\n`);
    } else {
      listProjects();
    }
    break;
  default:
    console.log(`
Auto Commit CLI (qq)

Usage:
  qq init        → Install AI commit hook
  qq config      → Configure key, models, co-author
  qq uninstall   → Remove hook
  qq projects    → List integrated projects
  qq projects --update → Update hooks manually

Examples:
  qq init
  qq config
  git commit
`);
}
