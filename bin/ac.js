#!/usr/bin/env node
import { spawnSync } from "child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import { homedir } from "os";

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

// === SHARED CONFIG ===
const CONFIG_DIR = join(homedir(), ".config", "ai-commit");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

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
    console.warn("⚠️ Failed to parse config, using defaults.");
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

// === UTILS (same as before, but simplified) ===

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
    "openai",
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
  // ... (same logic as before for Windows / Unix)
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

// === NEW: CONFIG INTERACTION ===

async function promptSelect(options, message) {
  const inquirer = await import("inquirer");
  const { choice } = await inquirer.default.prompt([
    { type: "list", name: "choice", message, choices: options },
  ]);
  return choice;
}

async function promptCheckbox(choices, message) {
  const inquirer = await import("inquirer");
  const { selected } = await inquirer.default.prompt([
    { type: "checkbox", name: "selected", message, choices },
  ]);
  return selected;
}

async function configInteractive() {
  const ALL_MODELS = DEFAULT_CONFIG.modelQueue;
  const config = loadConfig();

  while (true) {
    const action = await promptSelect(
      [
        { name: "🔑 View/edit API key", value: "key" },
        { name: "🧠 Model queue", value: "models" },
        {
          name: `👥 Co-author: ${config.coauthor ? "enabled" : "disabled"}`,
          value: "coauthor",
        },
        { name: "✅ Save & exit", value: "exit" },
      ],
      "Configuration",
    );

    if (action === "exit") break;

    if (action === "key") {
      const current = checkExistingKey();
      if (current) {
        console.log(
          `\nCurrent key: ${current.substring(0, 6)}...${current.slice(-4)}\n`,
        );
      } else {
        console.log("\n❌ No API key found.\n");
      }

      const choice = await promptSelect(
        [
          { name: "✏️ Enter new key", value: "new" },
          { name: "⬅️ Back", value: "back" },
        ],
        "What would you like to do?",
      );

      if (choice === "new") {
        const key = await askForKey();
        await saveKeyToEnv(key);
        console.log("✅ Key updated.\n");
      }
      // else: просто вернёмся в главное меню
    }

    if (action === "models") {
      console.log("\n🧠 Select your primary model");
      console.log(
        "💡 Fallback models will be added automatically (from smarter to simpler).\n",
      );

      const primary = await promptSelect(
        SMART_TO_SIMPLE_MODELS.map((m) => ({ name: m, value: m })),
        "Choose primary model:",
      );

      // Формируем очередь: primary + все модели, идущие ПОСЛЕ неё в списке
      const primaryIndex = SMART_TO_SIMPLE_MODELS.indexOf(primary);
      const fallbacks = SMART_TO_SIMPLE_MODELS.slice(primaryIndex + 1);
      const newQueue = [primary, ...fallbacks];

      config.modelQueue = newQueue;
      saveConfig(config);

      console.log("\n✅ Model queue updated:");
      newQueue.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
      console.log("");
    }

    if (action === "coauthor") {
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

// === INSTALL / UNINSTALL / RUN ===

function createGithooksDir() {
  const dir = join(process.cwd(), ".githooks");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function createCommitIgnoreFile() {
  const path = join(process.cwd(), ".commitignore");
  if (!existsSync(path)) writeFileSync(path, DEFAULT_COMMITIGNORE);
}

function copyHookFiles(githooksDir) {
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
}

function runPythonScript() {
  const python = checkPython();
  const script = join(process.cwd(), ".githooks", "ai_commit.py");
  if (!existsSync(script)) {
    console.error('❌ ai_commit.py not found. Run "qq init" first.');
    process.exit(1);
  }
  const result = spawnSync(python, [script], {
    stdio: "inherit",
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

async function install() {
  if (!existsSync(join(process.cwd(), ".git"))) {
    console.error("❌ Not a git repo.");
    process.exit(1);
  }

  installPythonDeps();
  const key = checkExistingKey() || (await askForKey());
  await saveKeyToEnv(key);

  createGithooksDir();
  copyHookFiles(createGithooksDir());
  createCommitIgnoreFile();
  setGitHooksPath();

  // Init shared config if missing
  if (!existsSync(CONFIG_FILE)) saveConfig(DEFAULT_CONFIG);

  console.log("🎉 Installed!");
}

function uninstall() {
  const githooks = join(process.cwd(), ".githooks");
  if (existsSync(githooks)) {
    spawnSync(
      process.platform === "win32" ? "cmd" : "rm",
      process.platform === "win32"
        ? ["/c", "rmdir", "/s", "/q", githooks]
        : ["-rf", githooks],
    );
  }
  unsetGitHooksPath();
  console.log("🗑️ Uninstalled.");
}

// === MAIN ===

const cmd = process.argv[2];
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
  case "go":
    runPythonScript();
    break;
  default:
    console.log(`
Auto Commit CLI (qq)

Usage:
  qq init        → Install
  qq config      → Configure key, models, co-author
  qq uninstall   → Remove
  qq go          → Generate message manually
`);
}
