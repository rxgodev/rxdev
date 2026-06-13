<div align="center">

# RXDev

**AI-powered developer workflow tool** — commit messages, code review, PR automation, analytics, and more.

[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-4.0.0-8250df)](https://github.com/rxgodev/rxcommit/releases)
[![CLI](https://img.shields.io/badge/cli-rxdev-4FC08D?logo=gnubash&logoColor=white)](.#readme)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![CI](https://img.shields.io/badge/CI-Windows%20%7C%20macOS%20%7C%20Ubuntu-4FC08D)](.github/workflows/ci.yml)

[Documentation](https://github.com/rxgodev/rxcommit#readme) · [Report Bug](https://github.com/rxgodev/rxcommit/issues) ·
[Русский](./docs/languages/ru-RU.md) · [中文](./docs/languages/zh-CN.md) · [Deutsch](./docs/languages/de-DE.md) · [Français](./docs/languages/fr-FR.md)

</div>

## Table of Contents

- [What's New in v4.0](#whats-new-in-v40)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Commands](#commands)
- [Providers & Models](#providers--models)
- [Configuration](#configuration)
- [GitHub Action](#github-action)
- [Documentation](#documentation)
- [License](#license)

---

## What's New in v4.0

- **Renamed** from `rxcommit` to `rxdev` — broader scope beyond just commits
- **AI Code Review** (`qq review`) — review staged changes or PRs before committing
- **Contextual Commits** — uses branch name, recent commits, and GitHub Issues for better messages
- **Analytics** (`qq analytics`) — commit statistics and bad practice detection
- **Smart Split** — auto-detects file types (tests, docs, config) for intelligent grouping
- **Config as Code** — `rxdev.yml` in your project root for team-shared settings
- **GitHub Action** — automatic AI review on every PR
- **Improved Diff System** — smart truncation (16K chars), never cuts files mid-way
- **Cross-platform CI** — tested on Windows, macOS, and Ubuntu

---

## Features

### QuickFlow (`qq go`)

The flagship workflow. Stage, generate, review, push in one command:

```
$ qq go
```

1. **Stage** — interactively choose files to include
2. **Generate** — AI analyses the diff and streams a Conventional Commit message in real-time
3. **Review** — see the message, choose what to do next
4. **Push** — accept and push, or edit, regenerate, or cancel

### AI Code Review (`qq review`)

Get instant feedback on your staged changes:

```
$ qq review
```

- Analyzes code for bugs, security issues, and performance problems
- Provides severity ratings (critical/warning/suggestion)
- Works on staged changes or PR diffs

### Contextual Commits

Commit messages that understand your workflow:

- **Branch context** — knows you're on `feature/user-auth`
- **Recent history** — considers the last 3 commits
- **GitHub Issues** — auto-links to issues from branch names (`fix/123`, `feature/PROJ-456`)

### Smart Split (`qq split`)

Split large changes into logical commits:

```
$ qq split
```

- Auto-detects test files → `test:` commits
- Auto-detects docs → `docs:` commits
- Auto-detects config files → `chore:` commits
- LLM handles the rest for intelligent grouping

### Analytics (`qq analytics`)

Understand your commit patterns:

```
$ qq analytics
```

- Commit statistics by type
- Average message length
- Breaking change detection
- Bad practice warnings (too long, non-conventional, etc.)

### GitHub Action

Automatic AI review on every PR:

```yaml
- uses: rxgodev/rxdev-review@v1
  with:
    api-key: ${{ secrets.RXDEV_API_KEY }}
```

### Other Features

- **Auto-bump version** — discovers 15+ manifest formats (package.json, Cargo.toml, pyproject.toml, etc.)
- **Secret scanning** — detects leaked credentials in staged changes
- **PR generation** — creates PR titles and descriptions from commits
- **Changelog generation** — builds CHANGELOG entries from conventional commits
- **History rewriting** — interactive `git-filter-repo` wrapper
- **Multi-project** — manage hooks across multiple repositories

---

## Installation

### Prerequisites

- **Node.js** >= 18
- An **API key** from one of the supported providers (see [Providers & Models](#providers--models))

### 1. Set up GitHub Package Registry

```bash
npm login --scope=@rxgodev --registry=https://npm.pkg.github.com/
```

Enter your GitHub username and a [personal access token](https://github.com/settings/tokens) with `write:packages` scope when prompted.

### 2. Install globally

**npm:**
```bash
npm install -g @rxgodev/rxdev@latest
```

**pnpm:**
```bash
pnpm add -g @rxgodev/rxdev@latest
```

**yarn:**
```bash
yarn global add @rxgodev/rxdev@latest
```

### 3. Configure your API key

```bash
rxdev config
```

Navigate to **API key** in the menu and paste your key.

---

## Quick Start

After installing, get your first AI-powered commit in seconds:

```bash
# Install the hook (one time per repo)
rxdev init

# QuickFlow — stage, generate, review, push
rxdev go
```

Or use the `qq` alias:
```bash
qq init
qq go
```

---

## Commands

| Command | Description |
|---------|-------------|
| `rxdev go` | **QuickFlow** — stage → scan → generate → review → push |
| `rxdev review` | AI code review of staged changes |
| `rxdev split` | Split staged changes into multiple logical commits |
| `rxdev scan` | Scan staged changes for leaked secrets |
| `rxdev analytics` | Show commit statistics and bad practices |
| `rxdev pr` | Generate a pull request title + description |
| `rxdev release` | Build CHANGELOG entry, commit & tag |
| `rxdev init` | Install the AI commit hook |
| `rxdev config` | Configure provider, model, language, and more |
| `rxdev status` | Show integration status |
| `rxdev doctor` | Diagnose your setup |
| `rxdev filter` | Rewrite git history |
| `rxdev uninstall` | Remove the hook |
| `rxdev version` | Show version number |
| `rxdev update` | Update to latest version |

All commands also work with `qq` alias: `qq go`, `qq review`, etc.

---

## Providers & Models

### Groq (default, free tier)

| Model | Speed | Context | Best for |
|-------|-------|---------|----------|
| Llama 3.3 70B Versatile | ~280 t/s | 128K | High quality, complex changes |
| Llama 3.1 8B Instant | ~560 t/s | 128K | Fast, simple changes (default) |
| Mixtral 8x7B | ~500 t/s | 32K | Balanced speed/quality |

### OpenAI

| Model | Context | Best for |
|-------|---------|----------|
| GPT-4o | 128K | Best quality |
| GPT-4o-mini | 128K | Fast, cost-effective (default) |
| GPT-4 Turbo | 128K | Legacy support |

### OpenRouter

Access to 100+ models through OpenRouter:
- `openai/gpt-4o` — GPT-4o via OpenRouter
- `anthropic/claude-3.5-sonnet` — Claude 3.5
- `meta-llama/llama-3.3-70b` — Llama 3.3
- Any model available on [openrouter.ai](https://openrouter.ai)

### Ollama (local, private)

Run any model locally — your code never leaves your machine:
- `llama3.1` — Meta's Llama 3.1
- `codellama` — Code-specialized Llama
- `mistral` — Mistral 7B
- Any model supported by [Ollama](https://ollama.ai)

### Custom Endpoint

Use any OpenAI-compatible API:
```bash
rxdev config
# Set Provider → custom
# Set API URL → https://your-api.com/v1/chat/completions
```

---

## Configuration

### Interactive Configuration

```bash
rxdev config
```

### Settings

| Setting | Description |
|---------|-------------|
| **Provider** | Choose LLM backend: Groq, OpenAI, OpenRouter, Ollama, or custom |
| **Model** | Pick a model for the chosen provider |
| **Language** | Choose language for commit body: English, Russian, German, French, Chinese |
| **Custom prompt** | Override system prompt. Use `{types}` placeholder |
| **Custom types** | Add extra Conventional Commits types |
| **API key** | Set provider API key (or use env vars) |
| **Co-author** | Toggle `Co-authored-by` trailer |
| **Auto-bump** | Toggle automatic version bumps |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `RXDEV_API_KEY` | API key (any provider) |
| `GROQ_API_KEY` | Groq-specific key |
| `OPENAI_API_KEY` | OpenAI-specific key |
| `OPENROUTER_API_KEY` | OpenRouter-specific key |

### Config as Code (`rxdev.yml`)

Create `rxdev.yml` in your project root for team-shared settings:

```yaml
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
```

Priority: `rxdev.yml` → CLI flags → `~/.config/rxdev/config.json` → defaults

### .commitignore

Edit `.commitignore` (follows `.gitignore` syntax) to exclude files from the diff sent to the model.

---

## GitHub Action

Automatic AI review on every PR:

```yaml
name: AI Review
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: rxgodev/rxdev-review@v1
        env:
          RXDEV_API_KEY: ${{ secrets.RXDEV_API_KEY }}
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](./docs/architecture.md) | High-level overview of the CLI + git-hook architecture |
| [Auto-bump](./docs/auto-bump.md) | Smart version bumping for 15+ manifest formats |
| [Templates & Projects](./docs/templates.md) | Multi-repository management and shared templates |
| [Changelog](./CHANGELOG.md) | Version history and changes |

---

## License

**MIT** — see [LICENSE](./LICENSE) for details.
