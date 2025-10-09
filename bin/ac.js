#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Путь к исходным файлам в пакете
const SOURCE_GITHOOKS_DIR = join(__dirname, '../.githooks');

// Содержимое .commitignore по умолчанию
const DEFAULT_COMMITIGNORE = `# Auto-commit configuration files
.githooks/
ai_commit.py
ai_commit_debug.log
.env
.env.local
.commitignore

# You can add more patterns below:
`;

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

// Проверяем наличие API ключа
function checkExistingKey() {
  // Проверяем переменную окружения
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }

  // Для Windows проверяем через REG QUERY
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('reg', 
        ['query', 'HKCU\\Environment', '/v', 'OPENAI_API_KEY'], 
        { stdio: 'pipe', encoding: 'utf8' }
      );
      if (result.status === 0 && result.stdout) {
        const match = result.stdout.match(/OPENAI_API_KEY\s+REG_\w+\s+(.+)/);
        if (match && match[1]) {
          return match[1].trim();
        }
      }
    } catch {}
  }

  // Для Unix-подобных систем проверяем в shell config
  const home = homedir();
  if (home) {
    const shell = process.env.SHELL || '/bin/bash';
    const rcFile = shell.includes('zsh') 
      ? join(home, '.zshrc') 
      : join(home, '.bashrc');
    
    if (existsSync(rcFile)) {
      try {
        const content = readFileSync(rcFile, 'utf8');
        const match = content.match(/export OPENAI_API_KEY="(.+)"/);
        if (match && match[1]) {
          return match[1];
        }
      } catch {}
    }
  }

  return null;
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

async function askYesNo(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(`${question} (y/n): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

async function saveKeyToEnv(key) {
  if (!key) {
    console.error('❌ Key is empty.');
    process.exit(1);
  }

  // Сохраняем в текущую сессию (работает везде)
  process.env.OPENAI_API_KEY = key;

  // === WINDOWS ===
  if (process.platform === 'win32') {
    try {
      const { execSync } = await import('child_process');
      // setx сохраняет переменную для текущего пользователя
      execSync(`setx OPENAI_API_KEY "${key}"`, { stdio: 'pipe' });
      console.log('✅ OPENAI_API_KEY saved to Windows user environment variables.');
      console.log('👉 Please restart your terminal for the changes to take effect.');
      return;
    } catch (e) {
      console.log('⚠️ Failed to save to Windows environment. Key will only persist in this session.');
      return;
    }
  }

  // === macOS / Linux ===
  const home = homedir();
  if (!home) {
    console.log('⚠️ Could not determine home directory. Key will only persist in this session.');
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
    let content = readFileSync(rcFile, 'utf8');
    const exportLine = `export OPENAI_API_KEY="${key}"`;
    const regex = /export OPENAI_API_KEY=".*"/;

    if (regex.test(content)) {
      content = content.replace(regex, exportLine);
      console.log(`✅ Updated OPENAI_API_KEY in ${rcFile}`);
    } else {
      content += `\n${exportLine}\n`;
      console.log(`✅ Added OPENAI_API_KEY to ${rcFile}`);
    }
    writeFileSync(rcFile, content, 'utf8');
  } else {
    console.log(`⚠️ Shell config file not found: ${rcFile}`);
    console.log('⚠️ Key will only persist in this session.');
  }
}

function createGithooksDir() {
  const githooksDir = join(process.cwd(), '.githooks');
  if (!existsSync(githooksDir)) {
    try {
      mkdirSync(githooksDir, { recursive: true });
      console.log(`✅ Created .githooks directory`);
    } catch (e) {
      console.error('❌ Failed to create .githooks directory:', e.message);
      process.exit(1);
    }
  }
  return githooksDir;
}

function createCommitIgnoreFile() {
  const commitIgnorePath = join(process.cwd(), '.commitignore');
  
  if (existsSync(commitIgnorePath)) {
    console.log('⚠️  .commitignore file already exists, skipping...');
    return;
  }

  try {
    writeFileSync(commitIgnorePath, DEFAULT_COMMITIGNORE, 'utf-8');
    console.log('✅ Created .commitignore file');
  } catch (e) {
    console.error('⚠️  Failed to create .commitignore file:', e.message);
    // Не прерываем установку из-за этой ошибки
  }
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

  // Делаем хук исполняемым (только на Unix-системах)
  if (process.platform !== 'win32') {
    spawnSync('chmod', ['+x', join(githooksDir, 'prepare-commit-msg')]);
  }
  console.log('✅ Hook files copied to .githooks/');
}

function runPythonScript(args) {
  const python = checkPython();
  const scriptPath = join(process.cwd(), '.githooks', 'ai_commit.py');
  if (!existsSync(scriptPath)) {
    console.error('❌ ai_commit.py not found in .githooks/');
    console.error('👉 Run "qq init" first to install the auto-commit hook.');
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

  // Проверяем существующий ключ
  const existingKey = checkExistingKey();
  let key = existingKey;
  
  if (existingKey) {
    console.log('✅ Found existing OPENAI_API_KEY');
    const shouldUpdate = await askYesNo('Do you want to update it?');
    if (shouldUpdate) {
      key = await askForKey();
      await saveKeyToEnv(key);
    } else {
      // Убеждаемся, что ключ доступен в текущей сессии
      process.env.OPENAI_API_KEY = existingKey;
    }
  } else {
    key = await askForKey();
    await saveKeyToEnv(key);
  }

  const githooksDir = createGithooksDir();
  copyHookFiles(githooksDir);
  createCommitIgnoreFile(); // Создаем .commitignore
  setGitHooksPath();

  console.log('🎉 Auto-commit installed successfully!');
  console.log('👉 Now try: git commit');
}

async function configure() {
  console.log('🔧 Configuring OPENAI_API_KEY...');
  
  const existingKey = checkExistingKey();
  if (existingKey) {
    console.log('✅ Found existing OPENAI_API_KEY');
    const shouldUpdate = await askYesNo('Do you want to update it?');
    if (!shouldUpdate) {
      console.log('✅ Configuration unchanged.');
      return;
    }
  }
  
  const key = await askForKey();
  await saveKeyToEnv(key);
  console.log('✅ Configuration updated.');
}

function uninstall() {
  console.log('🗑️  Uninstalling auto-commit...');

  const githooksDir = join(process.cwd(), '.githooks');
  if (existsSync(githooksDir)) {
    // Используем кроссплатформенное удаление
    if (process.platform === 'win32') {
      spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', githooksDir]);
    } else {
      spawnSync('rm', ['-rf', githooksDir]);
    }
    console.log('✅ Removed .githooks directory');
  }

  unsetGitHooksPath();
  console.log('✅ Git hooks path reset.');

  // Спрашиваем про .commitignore
  const commitIgnorePath = join(process.cwd(), '.commitignore');
  if (existsSync(commitIgnorePath)) {
    console.log('⚠️  .commitignore file found');
    console.log('   (keeping it, delete manually if needed)');
  }

  console.log('🎉 Auto-commit uninstalled!');
}

function start() {
  console.log('▶️  Starting manual commit message generation...');
  console.log('📝 Analyzing staged changes...\n');
  runPythonScript([]);
}

// --- Главный обработчик ---

const command = process.argv[2];

switch (command) {
  case 'init':
    install();
    break;
  case 'config':
    configure();
    break;
  case 'uninstall':
    uninstall();
    break;
  case 'go':
    start();
    break;
  default:
    console.log(`
Auto Commit CLI (qq)

Usage:
  qq init        → Install AI commit hook & create .commitignore
  qq config      → Update OPENAI_API_KEY
  qq uninstall   → Remove hook and config
  qq go          → Manually generate commit message for staged changes

Examples:
  qq init        # First time setup
  qq go          # Generate commit message without committing
  git commit     # Auto-generate message via hook
`);
    process.exit(0);
}
