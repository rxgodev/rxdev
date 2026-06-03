# 🧠 NeuroCommit

<div align="center">

**AI-генератор Conventional Commits сообщений**

[Установка](#установка) • [Возможности](#возможности) • [Настройка](#настройка) •  [Быстрый Старт](#быстрый-старт)

</div>

<div align="center">

  <a href="https://github.com/rxgodev/neuro-commit/blob/main/README.md">English</a>

</div>

NeuroCommit — CLI, который сам пишет сообщения коммитов в стиле [Conventional Commits](https://www.conventionalcommits.org/) на основе staged-диффа. Не думай о формулировках — просто коммить.

> [!NOTE]
> Сообщения коммитов генерируются через [Groq API](https://console.groq.com) — быстрый инференс на Llama 3.1 8B со стримингом.  
> Нужен бесплатный API-ключ от [console.groq.com](https://console.groq.com). Укажи его через `qq config`.

## Возможности

- 🤖 **AI-генерация** — заголовок в Conventional Commits на английском + тело на русском, объясняющее *почему*, на основе staged-диффа.
- 📈 **Умный авто-бамп версии** (опционально) — интеллектуально обнаруживает манифесты по всему репозиторию, не только в корне. Поддерживает 15+ типов:
  - `package.json`, `composer.json` (JSON-парсер)
  - `Cargo.toml`, `pyproject.toml` (TOML-парсер)
  - `pubspec.yaml`, `Chart.yaml`, `*.gemspec`, `setup.cfg`
  - `build.gradle`, `*.csproj`, `VERSION`, `version.txt`
  - И другие — авто-определение по имени файла.
  - `feat:` → minor, `!` или `BREAKING CHANGE` → major, остальное → patch
  - **Монорепозитории** — находит манифесты в поддиректориях
  - **Pre-release** — сохраняет `-alpha.1`, `+build` суффиксы
  - **Merge-safe** — если манифест уже в стейдже, читает его из индекса и накатывает бамп поверх
  - **Change-aware** — пропускает бамп, если изменения не затрагивают пакет
  - **Git tag** — использует последний semver-тег, если в манифесте нет версии
- ✏️ **Правка до коммита** — `qq go` показывает сгенерированное сообщение и даёт открыть `$EDITOR`, перегенерировать или отменить.
- 📂 **Несколько проектов** — управление хуками и общими шаблонами в нескольких репо из одного места.
- 🚫 **Список игнорируемых** — `.commitignore` работает как `.gitignore`; подходящие файлы исключаются из диффа, отправляемого модели.

## Установка

#### Вход в pnpm
1. Получите PAT-ключ от аккаунта по [ссылке](https://github.com/settings/tokens) с правом `write:packages`

```bash
# 2. Войдите в pnpm
pnpm login --scope=@rxgodev --registry=https://npm.pkg.github.com/
```

3. Введите свой юзернейм и токен (в поле "Пароль")

#### Установка из pnpm

```bash
pnpm add -g @rxgodev/neuro-commit@latest
```

NeuroCommit успешно установлен 🎉

## Настройка

```bash
qq config
```

В меню:
- **🔑 API key** — указать или удалить Groq API-ключ с [console.groq.com](https://console.groq.com).  
  API-ключ обязателен для Groq (получить бесплатно).
- **👥 Co-author** — добавлять ли строку `Co-authored-by` в сообщение коммита.
- **📈 Auto-bump version** — умный автоматический бамп версии для 15+ типов манифестов (JSON, TOML, YAML, XML, Gradle, plain text). По умолчанию выключено.
- **📂 Projects & Templates** — список подключённых проектов и общие шаблоны `prepare-commit-msg`.

#### .commitignore

Редактируйте `.commitignore` так же, как `.gitignore`, чтобы исключить файлы из диффа, отправляемого модели. По умолчанию там перечислены файлы из `.githooks`.

## Быстрый Старт

```bash
# Установка хука в текущем репо
qq init

# Стейдж и коммит — сообщение генерируется автоматически
git add .
git commit

# Или гид-режим: стейдж + коммит + ревью + пуш
qq go
```

В `qq go` после генерации сообщения можно:
- ✅ **Push** — принять и запушить
- ✏️ **Edit message** — открыть `$EDITOR` и поправить
- 🔄 **Regenerate** — попросить модель ещё раз
- ❌ **Cancel** — soft-reset и отмена

## Команды

| Команда | Что делает |
|---|---|
| `qq init` | Установить хук в текущем репо |
| `qq go` | Гид: стейдж → коммит → ревью → пуш |
| `qq config` | Настройка API-ключа, co-author, авто-бампа, проектов, шаблонов |
| `qq status` | Статус интеграции в текущем репо |
| `qq retry` | Откатить последний коммит и пересгенерировать сообщение |
| `qq uninstall` | Удалить хук из текущего репо |

## License

[LICENSE](./LICENSE)
