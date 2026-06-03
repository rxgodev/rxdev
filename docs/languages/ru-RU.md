<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white" alt="Node version">
  <img src="https://img.shields.io/badge/version-2.15.3-8250df" alt="Version">
  <img src="https://img.shields.io/badge/cli-qq-4FC08D?logo=gnubash&logoColor=white" alt="CLI">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/badge/provider-Groq-FF6C2C?logo=groq&logoColor=white" alt="Groq">
  <img src="https://img.shields.io/badge/model-Llama%203.1%2F3.3-8250df" alt="Llama 3.1/3.3">
</p>

# NeuroCommit

**AI-генератор Conventional Commit сообщений** — анализирует ваш staged-дифф и создаёт осмысленные, стандартизированные сообщения коммитов через [Groq](https://console.groq.com) (на базе Meta Llama 3.1/3.3). Работает как Git-хук, интерактивный CLI или автономный генератор.

<p align="center">
  <a href="https://github.com/rxgodev/ac-cli#readme"><b>Документация</b></a>
  ·
  <a href="https://github.com/rxgodev/ac-cli/issues"><b>Сообщить об ошибке</b></a>
  ·
  <a href="https://github.com/rxgodev/neuro-commit/blob/main/README.md">English</a>
</p>

---

## Содержание

- [Возможности](#возможности)
- [Установка](#установка)
- [Быстрый старт](#быстрый-старт)
- [Команды](#команды)
- [Настройка](#настройка)
- [Лицензия](#лицензия)

---

## Возможности

- **AI-генерация коммитов** — заголовок в Conventional Commits на английском и тело на русском, объясняющее *почему*, на основе staged-диффа.
- **Авто-бамп версии (опционально)** — интеллектуально обнаруживает манифесты по всему репозиторию (поддержка монорепозиториев). Поддерживает 15+ форматов:
  - `package.json`, `composer.json` — JSON-парсер
  - `Cargo.toml`, `pyproject.toml` — TOML-парсер
  - `pubspec.yaml`, `Chart.yaml`, `*.gemspec`, `setup.cfg`
  - `build.gradle`, `*.csproj`, `VERSION`, `version.txt`
  - Авто-определение по имени файла; настройка не требуется.
  - `feat:` → **minor** бамп, `!` / `BREAKING CHANGE` → **major**, остальное → **patch**
  - Pre-release safe — сохраняет `-alpha.1`, `+build` суффиксы.
  - Merge-safe — читает уже застейдженные манифесты из индекса.
  - Change-aware — пропускает бамп, если изменения не затрагивают пакет.
  - Git-tag aware — использует последний semver-тег, если в манифесте нет версии.
- **Правка до коммита** — `qq go` позволяет просмотреть, перегенерировать или открыть `$EDITOR` для правки сообщения перед отправкой.
- **Несколько проектов** — управляйте хуками и общими шаблонами `prepare-commit-msg` в нескольких репозиториях из одного места.
- **Список игнорирования** — `.commitignore` работает как `.gitignore`; подходящие файлы исключаются из диффа, отправляемого модели.

---

## Установка

### Предварительные требования

- **Node.js** >= 22
- **Бесплатный API-ключ** от [console.groq.com](https://console.groq.com)

### 1. Настройте GitHub Package Registry

```bash
pnpm login --scope=@rxgodev --registry=https://npm.pkg.github.com/
```

Введите ваш GitHub-username и [персональный токен доступа](https://github.com/settings/tokens) с правами `write:packages` (токен вводится в поле "Password").

### 2. Установите глобально

```bash
pnpm add -g @rxgodev/neuro-commit@latest
```

### 3. Настройте API-ключ

```bash
qq config
```

Перейдите в пункт **API key** в меню и вставьте ваш Groq-ключ.

---

## Быстрый старт

```bash
# Установите AI-хук в текущем репозитории
qq init

# Застейджьте файлы и сделайте коммит — сообщение сгенерируется автоматически
git add .
git commit

# Или используйте гид-режим: стейдж → коммит → ревью → пуш
qq go
```

Команда `qq go` проводит вас по полному циклу. После генерации сообщения вы можете:

- **Push** — принять и запушить сразу
- **Edit message** — открыть `$EDITOR` и поправить
- **Regenerate** — попросить модель создать новый вариант
- **Cancel** — soft-reset и отмена

---

## Команды

| Команда        | Что делает |
|----------------|------------|
| `qq init`      | Установить AI-хук в текущем репозитории |
| `qq go`        | Гид-режим: стейдж → коммит → ревью → пуш |
| `qq config`    | Настройка API-ключа, модели, co-author, авто-бампа, проектов и шаблонов |
| `qq status`    | Статус интеграции в текущем репозитории |
| `qq uninstall` | Удалить хук из репозитория |

---

## Настройка

```bash
qq config
```

### Параметры

| Параметр            | Описание |
|---------------------|----------|
| **Model**           | Выбор модели: Llama 3.1 **8B** (быстрее, ~560 t/s) или **70B** (умнее, ~280 t/s) |
| **Custom prompt**   | Свой системный промпт. Используйте `{types}` как плейсхолдер — вместо него подставится список разрешённых типов (feat, fix, chore, docs, style, refactor, perf, test, build, ci, revert + ваши кастомные) |
| **Custom types**    | Добавьте свои типы коммитов сверх встроенных (например `hotfix, deps, i18n, ui, api, db`) |
| **API key**         | Указать или удалить Groq API-ключ |
| **Co-author**       | Добавлять ли строку `Co-authored-by` в сообщение коммита |
| **Auto-bump**       | Включить/отключить автоматический бамп версии для 15+ типов манифестов (по умолчанию выключено) |
| **Projects & Templates** | Список подключённых проектов и общие шаблоны `prepare-commit-msg` |

### .commitignore

Редактируйте `.commitignore` (синтаксис как у `.gitignore`), чтобы исключить файлы из диффа, отправляемого модели. По умолчанию там перечислены файлы из `.githooks`.

---

## Лицензия

**MIT** — подробнее в [LICENSE](./LICENSE).
