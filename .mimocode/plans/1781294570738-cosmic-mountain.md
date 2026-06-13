# RXDev v4.0.0 — Major Release Plan

## Overview
Переименование проекта rxcommit → rxdev, добавление AI code review, контекстных коммитов, GitHub Action, аналитики, smart split, конфигурации как код, и кардинальное обновление README.

---

## Phase 0: Merge PR #27
**Первый шаг — закрыть текущий PR.**

1. Перейти на `main`, замержить `improvements/bugfixes-security-testing`
2. Удалить ветку `improvements/bugfixes-security-testing`
3. Проверить что `main` в актуальном состоянии

---

## Phase 1: Переименование rxcommit → rxdev
**Breaking change → v4.0.0**

### 1.1 Переименование в package.json
**Файл:** `package.json`
- `"name": "@rxgodev/rxdev"`
- `"bin": { "rxdev": "bin/ac.js", "qq": "bin/ac.js" }` (qq как alias)
- `"version": "4.0.0"`
- Обновить repository URL если нужно

### 1.2 Переименование в коде
**Файлы:** `bin/ac.js`, `.githooks/ai_commit.mjs`
- `NEURO_COMMIT_VERSION` → `RXDEV_VERSION`
- `NEURO_COMMIT_API_KEY` → `RXDEV_API_KEY` (с fallback на старое имя)
- `NEURO_COMMIT_SKIP_BUMP` → `RXDEV_SKIP_BUMP` (с fallback)
- Константы: `ai-commit` → `rxdev` в путях конфигов
- Конфиг-директория: `~/.config/ai-commit/` → `~/.config/rxdev/` (с миграцией со старой)
- Лог-сообщения, баннеры, help-текст

### 1.3 Переименование файлов
- `bin/ac.js` → `bin/rxdev.js` (с `qq` alias через симлинк или redirects)
- `.githooks/ai_commit.mjs` → `.githooks/rxdev.mjs`
- `.githooks/prepare-commit-msg` → обновить вызов

### 1.4 Миграция конфигов
**Файл:** `bin/rxdev.js`
- При первом запуске: проверить `~/.config/ai-commit/config.json`
- Если найден — скопировать в `~/.config/rxdev/config.json`
- Старый конфиг не удалять (обратная совместимость)

### 1.5 npm deprecate
```bash
npm deprecate @rxgodev/rxcommit "Moved to @rxgodev/rxdev"
```

**Verification:**
- `node bin/rxdev.js version` → `v4.0.0`
- `node bin/rxdev.js --help` → показывает rxdev
- `qq version` → работает через alias
- Конфиг мигрируется из старой директории

---

## Phase 2: Улучшение системы диффов
**Текущая проблема:** `diff.slice(0, 3000)` — грубое обрезание по символам, LLM не знает о неполном диффе.

### 2.1 Умное обрезание диффа
**Файл:** `.githooks/rxdev.mjs` (бывший ai_commit.mjs)

Заменить `MAX_DIFF_LENGTH = 3000` на умную систему:

```js
function truncateDiff smart(diff, maxChars = 8000) {
  // 1. Разбить по файлам (по маркерам "# File:")
  // 2. Сортировать файлы: сначала основные changes, потом次要
  // 3. Заполнять до maxChars, не разрывая файл посередине
  // 4. Если дифф обрезан — добавить "[diff truncated, N more files]"
  // 5. Вернуть { diff, truncated, totalFiles, includedFiles }
}
```

### 2.2 Увеличить лимит
- `MAX_DIFF_LENGTH`: 3000 → 16000 (учитывая что modern LLMs support 128K+ context)
- Сделать настраиваемым через конфиг: `maxDiffLength`

### 2.3 Контекстная информация в промпте
**Файл:** `.githooks/rxdev.mjs` — `generateCommitMessage()`
- Добавить в user prompt информацию о ветке: `Branch: feature/auth`
- Добавить информацию о количестве файлов: `Files changed: 5`
- Если дифф обрезан: `Note: diff was truncated, showing N of M files`
- Добавить последние 3 коммита в ветке для контекста

### 2.4 Обновить system prompt
**Файл:** `.githooks/rxdev.mjs` — `buildSystemPrompt()`
- Добавить инструкции по обработке неполного диффа
- Добавить примеры с контекстом ветки

**Verification:**
- Large diff (>3000 chars) обрабатывается без потери файлов
- System prompt содержит контекст ветки
- Тест: создать staged diff >16K chars, проверить что commit message учитывает все файлы

---

## Phase 3: QQ Review — AI Code Review
**Новая команда: `rxdev review` (или `qq review`)**

### 3.1 Ревью staged изменений
**Новый экспорт в `.githooks/rxdev.mjs`:**

```js
export async function buildReview(diff, cfg, opts) {
  // 1. Собрать diff через getStagedDiff()
  // 2. System prompt: "You are a senior code reviewer..."
  // 3. User prompt: diff + инструкции по ревью
  // 4. LLM возвращает:潜在ные баги, security issues, performance, suggestions
  // 5. Форматированный вывод: файл:строка → проблема
}
```

### 3.2 Ревью PR через GitHub API
**Новый экспорт:**

```js
export async function buildPrReview(prNumber, cfg, opts) {
  // 1. gh pr diff <number> — получить дифф PR
  // 2. gh pr view <number> --json title,body — получить описание
  // 3. Отправить в LLM с system prompt для PR review
  // 4. Вернуть: { summary, comments: [{file, line, severity, message}] }
}
```

### 3.3 CLI-команда review
**Файл:** `bin/rxdev.js`
```js
case "review":
  // Если staged changes → buildReview()
  // Если аргумент число → buildPrReview(number)
  // Интерактивный выбор: review staged или review PR
```

### 3.4 Вывод ревью
- Цветной вывод в терминал (red=critical, yellow=warning, blue=suggestion)
- Опция `--json` для machine-readable output
- Опция `--fix` для автоматического применения fixable suggestions

**Verification:**
- `rxdev review` → ревью staged changes
- `rxdev review 42` → ревью PR #42
- `rxdev review --json` → JSON output

---

## Phase 4: Контекстные коммиты
**Улучшение качества коммит-сообщений за счёт контекста.**

### 4.1 Сбор контекста
**Файл:** `.githooks/rxdev.mjs`

Новая функция `gatherContext()`:
```js
async function gatherContext(repoRoot, cfg) {
  return {
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    recentCommits: collectCommits("HEAD~3..HEAD"),  // последние 3 коммита
    issue: await detectIssueFromBranch(branch),       // PROJ-123 из названия ветки
    issueBody: issue ? await fetchIssueBody(issue) : null,  // GitHub Issues API
    prDescription: await detectPrDescription(),       // если внутри PR
  };
}
```

### 4.2 Обогащение промпта
**Файл:** `.githooks/rxdev.mjs` — `generateCommitMessage()`
- Добавить контекст в user prompt:
  ```
  Context:
  - Branch: feature/user-auth
  - Recent commits: fix: handle null user, feat: add login form
  - Related issue: #42 "Add user authentication"
  - Issue description: Users need to be able to login with email...
  
  Diff:
  ---
  <diff>
  ---
  ```

### 4.3 GitHub Issues интеграция
**Файл:** `.githooks/rxdev.mjs`

```js
async function fetchIssueBody(issueNumber) {
  // Использовать gh CLI: gh issue view <number> --json body
  // Кэшировать результат на время сессии
  // Fallback если gh не установлен или нет доступа
}
```

### 4.4 Автоматическое связывание
- Если ветка содержит номер задачи (feature/PROJ-123, fix/42, etc.) → автоматически подтянуть задачу
- Если коммит содержит Closes #N → добавить в body

**Verification:**
- Ветка `feature/PROJ-123` → коммит содержит контекст задачи
- Последние коммиты влияют на тип коммита (не повторять feat если уже был)

---

## Phase 5: GitHub Action — Полный пайплайн
**Новый файл: `.github/workflows/rxdev-review.yml`**

### 5.1 AI Review на каждый PR
```yaml
name: RXDev AI Review
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm install -g @rxgodev/rxdev
      - run: rxdev pr-review ${{ github.event.pull_request.number }}
        env:
          RXDEV_API_KEY: ${{ secrets.RXDEV_API_KEY }}
      - uses: actions/github-script@v7
        with:
          script: |
            # Запостить комментарии к PR
```

### 5.2 Автогенерация коммитов (опционально)
```yaml
      - run: rxdev auto-commit
        if: contains(github.event.pull_request.labels.*.name, 'auto-commit')
```

### 5.3 Автоchangelog + release
```yaml
      - run: rxdev release --auto
        if: github.ref == 'refs/heads/main'
```

### 5.4 Secrets
- `RXDEV_API_KEY` — API key для LLM provider
- Опционально: `RXDEV_GITHUB_TOKEN` для расширенного доступа

**Verification:**
- Открыть PR → автоматический review комментарий
- Замержить в main → автоматический changelog + release

---

## Phase 6: Аналитика
**Новая команда: `rxdev analytics`**

### 6.1 Статистика коммитов
```js
export function analyzeCommits(revRange = "HEAD~50..HEAD") {
  const commits = collectCommits(revRange);
  return {
    total: commits.length,
    byType: countByType(commits),        // { feat: 12, fix: 8, ... }
    avgMessageLength: avg(commits.map(c => c.subject.length)),
    breakingChanges: commits.filter(c => c.subject.includes("!")).length,
    filesChanged: getChangedFiles(revRange),
    codeChurn: getCodeChurn(revRange),   // строки добавлено/удалено
  };
}
```

### 6.2 Detection bad practices
```js
export function detectBadPractices(commits) {
  const issues = [];
  // Слишком длинные коммиты (>100 chars)
  // Смешанные типы (feat + fix в одном коммите)
  // Нет scope в fix коммитах
  // Слишком много файлов в одном коммите
  // Нет body в breaking changes
  return issues;
}
```

### 6.3 CLI
```bash
rxdev analytics                    # статистика последних 50 коммитов
rxdev analytics --range HEAD~10..HEAD  # конкретный диапазон
rxdev analytics --json             # JSON output
```

**Verification:**
- `rxdev analytics` → выводит статистику
- Детектит bad practices

---

## Phase 7: Smart Split
**Улучшение `qq split` — умная группировка файлов.**

### 7.1 Группировка по модулям
**Файл:** `.githooks/rxdev.mjs` — `buildSplitPlan()`

Текущая логика: LLM решает как разбить. Новая логика:
```js
function groupFilesByModule(files) {
  // 1. Определить корни модулей (src/, lib/, packages/, etc.)
  // 2. Сгруппировать файлы по общему родителю
  // 3. Предложить: "Эти 3 файла — auth модуль, эти 2 — api модуль"
  // 4. LLM получает сгруппированный diff вместо плоского списка
}
```

### 7.2 Автоопределение типа изменений
- Файлы тестов → `test:` коммит
- Файлы docs/ → `docs:` коммит
- package.json / Cargo.toml → `chore:` коммит
- src/ файлы → `feat:` или `fix:` (по LLM решению)

### 7.3 Интерактивный выбор
- Показать предложенные группы
- Позволить merge/split группы
- Preview каждого коммита перед применением

**Verification:**
- `rxdev split` → файлы сгруппированы по модулям
- Тесты и docs в отдельных коммитах

---

## Phase 8: Конфигурация как код
**Новый файл: `rxdev.yml` в корне проекта**

### 8.1 Формат конфига
```yaml
# rxdev.yml
provider: groq
model: llama-3.3-70b-versatile
language: en
maxDiffLength: 16000
coauthor: true
bumpVersion: false
validTypes:
  - feat
  - fix
  - docs
  - refactor
  - perf
  - test
  - chore
customPrompt: ""  # пусто = дефолтный
review:
  severity: warning  # min severity to show
  autoFix: false
context:
  useIssues: true
  useRecentCommits: 3
```

### 8.2 Приоритет конфигов
1. `rxdev.yml` в корне проекта (проект-специфичный)
2. CLI флаги (`--provider`, `--model`, etc.)
3. `~/.config/rxdev/config.json` (глобальный)
4. Defaults

### 8.3 qq config остаётся
- `qq config` / `rxdev config` — интерактивное меню
- При сохранении: обновляет `~/.config/rxdev/config.json`
- Новая опция: "Export to rxdev.yml" — создаёт файл в текущей директории

**Verification:**
- `rxdev.yml` в корне проекта переопределяет глобальный конфиг
- `qq config` по-прежнему работает
- `rxdev config --export` создаёт rxdev.yml

---

## Phase 9: Обновление README.md
**Кардинальное обновление документации.**

### 9.1 Название и описание
- Заголовок: "RXDev — AI-powered developer workflow tool"
- Подзаголовок: "Commit messages, code review, PR automation, and more"
- Убрать "git commit message generator" — это теперь малая часть

### 9.2 Провайдеры и модели
Текущий README показывает только Groq с 2 моделями. Обновить на:
- **Groq**: llama-3.3-70b-versatile, llama-3.1-8b-instant, mixtral-8x7b-32768
- **OpenAI**: gpt-4o, gpt-4o-mini, gpt-4-turbo
- **OpenRouter**: любая модель через openrouter.ai
- **Ollama**: любая локальная модель
- **Custom**: любой OpenAI-совместимый endpoint

### 9.3 Новые фичи
Добавить секции:
- ⚡ Quick Start (обновить команды)
- 🔄 AI Review (`rxdev review`)
- 🌿 Contextual Commits (ветка + issues)
- 📊 Analytics (`rxdev analytics`)
- 📦 Smart Split (`rxdev split`)
- ⚙️ Configuration as Code (`rxdev.yml`)
- 🚀 GitHub Action

### 9.4 Обновить badges
- Версия: `4.0.0`
- CI: Windows/macOS/Ubuntu
- License: MIT

### 9.5 Обновить команды в таблице
Добавить: `review`, `analytics`, `pr-review`
Обновить: `go`, `split`, `pr`, `release`

### 9.6 Языковые версии
Обновить все 4 перевода (ru, zh, de, fr)

**Verification:**
- README отражает все новые фичи
- Все ссылки работают
- Badges актуальны

---

## Phase 10: Тесты и финальная проверка

### 10.1 Обновить существующие тесты
- Переименовать `test_ai_commit.mjs` → `test_rxdev.mjs`
- Обновить импорты: `ai_commit.mjs` → `rxdev.mjs`
- Добавить тесты для нового функционала

### 10.2 Новые тесты
- `test_review.mjs` — тесты AI review (с mock HTTP сервером)
- `test_context.mjs` — тесты контекстных коммитов
- `test_config.mjs` — тесты конфигурации как код

### 10.3 Обновить CI
- `.github/workflows/ci.yml` — обновить пути к файлам
- `.github/workflows/rxdev-review.yml` — новый workflow

### 10.4 Финальная проверка
- Все тесты проходят
- `npm run lint` без ошибок
- `rxdev --help` показывает все команды
- `qq --help` работает через alias
- README актуален

---

## Execution Order

| Phase | Описание | Effort |
|-------|----------|--------|
| 0 | Merge PR #27 | 5 min |
| 1 | Переименование rxcommit → rxdev | 3-4h |
| 2 | Улучшение системы диффов | 2-3h |
| 3 | QQ Review (staged + PR) | 4-5h |
| 4 | Контекстные коммиты | 3-4h |
| 5 | GitHub Action | 3-4h |
| 6 | Аналитика | 2-3h |
| 7 | Smart Split | 2-3h |
| 8 | Конфигурация как код | 2-3h |
| 9 | Обновление README | 2-3h |
| 10 | Тесты и финальная проверка | 3-4h |

**Total estimated effort:** 27-37 hours

---

## Критические файлы

| Файл | Изменения |
|------|-----------|
| `package.json` | Rename, version 4.0.0, new scripts |
| `.githooks/rxdev.mjs` | Rename, diff improvement, review, context, analytics |
| `bin/rxdev.js` | Rename, new commands (review, analytics), config yml |
| `.github/workflows/ci.yml` | Update paths |
| `.github/workflows/rxdev-review.yml` | New GitHub Action |
| `rxdev.yml` | New config file (example) |
| `README.md` | Complete rewrite |
| `docs/languages/*.md` | Update translations |
| `tests/test_rxdev.mjs` | Rename + new tests |
