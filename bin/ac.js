#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { existsSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Путь к исходным файлам в пакете
const SOURCE_GITHOOKS_DIR = join(__dirname, '../.githooks');

// --- Вспомогательные функции ---

function checkPython() {
  try {
    const result = spawnSync('python3', ['--version'], { stdio: 'pipe' });
    if (result.status === 0) return 'python3';
  } catch {}
  try {
    const result = spawnSync('python', ['--version'], { stdio: 'pipe' });
    if (result.status === 0) return 'python';
  } catch {}
  console.error('❌ Python 3.8+ is required but not found.');
  process.exit(1);
}

function installPythonDeps() {
  console.log('📦 Installing Python dependencies...');
  const packages = ['openai', 'pathspec'];
  const cmd = [checkPython(), '-m', 'pip', 'install', '--quiet', ...packages];
  const result = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('❌ Failed to install Python dependencies.');
    process.exit(1);
  }
}

function setGitHooksPath() {
  const result = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: process.cwd(),
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    console.error('❌ Failed to set git hooks path.');
    process.exit(1);
  }
}

function unsetGitHooksPath() {
  spawnSync('git', ['config', '--unset', 'core.hooksPath'], {
    cwd: process.cwd(),
    stdio: 'ignore'
  });
}

function askForKey() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('Enter your OPENAI_API_KEY: ', (key) => {
      rl.close();
      resolve(key.trim());
    });
  });
}

async function saveKeyToEnv(key) {
  if (!key) {
    console.error('❌ Key is empty.');
    process.exit(1);
  }

  // Сохраняем в текущую сессию
  process.env.OPENAI_API_KEY = key;

  // Пытаемся сохранить в shell profile (для будущих сессий)
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    console.log('⚠️  Could not determine home directory. Key will only persist in this session.');
    return;
  }

  const shell = process.env.SHELL || '/bin/bash';
  let rcFile;
  if (shell.includes('zsh')) {
    rcFile = join(home, '.zshrc');
  } else {
    rcFile = join(home, '.bashrc');
  }

  if (existsSync(rcFile)) {
    let content = readFileSync(rcFile, 'utf-8');
    const exportLine = `export OPENAI_API_KEY="${key}"`;
    const regex = /export OPENAI_API_KEY=".*"/;

    if (regex.test(content)) {
      content = content.replace(regex, exportLine);
      console.log(`✅ Updated OPENAI_API_KEY in ${rcFile}`);
    } else {
      content += `\n${exportLine}\n`;
      console.log(`✅ Added OPENAI_API_KEY to ${rcFile}`);
    }
    writeFileSync(rcFile, content, 'utf-8');
  } else {
    console.log(`⚠️  Shell config file not found. Key will only persist in this session.`);
  }
}

function createGithooksDir() {
  const githooksDir = join(process.cwd(), '.githooks');
  if (!existsSync(githooksDir)) {
    try {
      require('fs').mkdirSync(githooksDir, { recursive: true });
      console.log(`✅ Created .githooks directory`);
    } catch (e) {
      console.error('❌ Failed to create .githooks directory.');
      process.exit(1);
    }
  }
  return githooksDir;
}

function copyHookFiles(githooksDir) {
  const files = ['ai_commit.py', 'prepare-commit-msg'];
  files.forEach(file => {
    const src = join(SOURCE_GITHOOKS_DIR, file);
    const dst = join(githooksDir, file);
    if (!existsSync(src)) {
      console.error(`❌ Missing file in package: ${src}`);
      process.exit(1);
    }
    const content = readFileSync(src, 'utf-8');
    writeFileSync(dst, content);
  });

  // Делаем хук исполняемым
  spawnSync('chmod', ['+x', join(githooksDir, 'prepare-commit-msg')]);
  console.log('✅ Hook files copied to .githooks/');
}

function runPythonScript(args) {
  const python = checkPython();
  const scriptPath = join(process.cwd(), '.githooks', 'ai_commit.py');
  if (!existsSync(scriptPath)) {
    console.error('❌ ai_commit.py not found in .githooks/');
    process.exit(1);
  }

  const result = spawnSync(python, [scriptPath, ...args], {
    stdio: 'inherit',
    env: { ...process.env, PYTHONUNBUFFERED: '1' }
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

// --- Команды ---

async function install() {
  console.log('🚀 Installing auto-commit...');

  if (!existsSync(join(process.cwd(), '.git'))) {
    console.error('❌ Not a git repository.');
    process.exit(1);
  }

  installPythonDeps();

  const key = await askForKey();
  await saveKeyToEnv(key);

  const githooksDir = createGithooksDir();
  copyHookFiles(githooksDir);
  setGitHooksPath();

  console.log('🎉 Auto-commit installed successfully!');
  console.log('👉 Now try: git commit');
}

async function configure() {
  console.log('🔧 Configuring OPENAI_API_KEY...');
  const key = await askForKey();
  await saveKeyToEnv(key);
  console.log('✅ Configuration updated.');
}

function uninstall() {
  console.log('🗑️  Uninstalling auto-commit...');

  const githooksDir = join(process.cwd(), '.githooks');
  if (existsSync(githooksDir)) {
    spawnSync('rm', ['-rf', githooksDir]);
    console.log('✅ Removed .githooks directory');
  }

  unsetGitHooksPath();
  console.log('✅ Git hooks path reset.');

  console.log('🎉 Auto-commit uninstalled!');
}

function start() {
  console.log('▶️ Starting manual commit message generation...');
  runPythonScript([]);
}

async function checkVersion() {
  // Импортируем fs и path как ESM
  const { readFile } = await import('fs/promises');
  const { join } = await import('path');
  const https = await import('https');

  try {
    // Читаем package.json
    const packageJsonPath = join(import.meta.url.replace('file://', ''), '../package.json');
    const packageJsonContent = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    const packageJson = JSON.parse(packageJsonContent);
    const current = packageJson.version;
    console.log(`ℹ️ Current version: ${current}`);

    // Получаем последнюю версию из registry
    const packageName = 'ac';
    const registryUrl = `https://npm.pkg.github.com/rxgodev/${encodeURIComponent(packageName)}`;

    const latest = await new Promise((resolve, reject) => {
      https.get(registryUrl, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const info = JSON.parse(data);
            resolve(info['dist-tags']?.latest || info.version);
          } catch (e) {
            reject(new Error('Invalid registry response'));
          }
        });
      }).on('error', reject);
    });

    console.log(`🆕 Latest version: ${latest}`);

    // Простое сравнение версий x.y.z
    const compareVersions = (v1, v2) => {
      const [a1, b1, c1] = v1.split('.').map(Number);
      const [a2, b2, c2] = v2.split('.').map(Number);
      if (a2 > a1) return -1;
      if (a2 < a1) return 1;
      if (b2 > b1) return -1;
      if (b2 < b1) return 1;
      if (c2 > c1) return -1;
      if (c2 < c1) return 1;
      return 0;
    };

    if (compareVersions(current, latest) < 0) {
      console.log(`🔔 Update available!`);
      console.log(`👉 Run: pnpm add -g @rxgodev/ac@latest`);
    } else {
      console.log(`✅ You are up to date!`);
    }
  } catch (e) {
    console.warn(`⚠️ Could not check latest version: ${e.message}`);
  }
}

// --- Главный обработчик ---

const command = process.argv[2];

switch (command) {
  case 'init':
    install();
    break;
  case 'configure':
    configure();
    break;
  case 'uninstall':
    uninstall();
    break;
  case 'start':
    start();
    break;
  case 'version':
    checkVersion();
    break;
  default:
    console.log(`
Auto Commit CLI (ac)

Usage:
  ac init        → Install AI commit hook
  ac configure   → Update OPENAI_API_KEY
  ac uninstall   → Remove hook and config
  ac start       → Manually generate commit message

Example:
  ac init
  git commit
`);
    process.exit(0);
}
