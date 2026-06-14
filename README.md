<div align="center">

# RXDev

**AI-powered developer workflow tool** — commit messages, code review, PR automation, analytics, and more.

[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-4.0.0-8250df)](https://github.com/rxgodev/rxdev/releases)
[![CLI](https://img.shields.io/badge/cli-rxdev-4FC08D?logo=gnubash&logoColor=white)](.#readme)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![CI](https://img.shields.io/badge/CI-Windows%20%7C%20macOS%20%7C%20Ubuntu-4FC08D)](.github/workflows/ci.yml)

[Documentation](https://github.com/rxgodev/rxdev#readme) · [Report Bug](https://github.com/rxgodev/rxdev/issues) ·
[Русский](./docs/languages/ru-RU.md) · [中文](./docs/languages/zh-CN.md) · [Deutsch](./docs/languages/de-DE.md) · [Français](./docs/languages/fr-FR.md)

</div>

## Table of Contents

- [What's New in v4.1](#whats-new-in-v41)
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

## What's New in v4.1

- **Full Interface Localization** — entire interface in your language (en/ru/de/fr/zh)
- **Token Management** — track usage, set daily/monthly limits, get warnings
- **Command Suggestions** — "Did you mean 'stats'?" for typos
- **Improved File Picker** — shows file sizes, better navigation
- **New Command** — `rxdev tokens` for token usage statistics

---

## What's New in v4.0

- **Renamed** from `rxcommit` to `rxdev` — broader scope beyond just commits
- **AI Code Review** (`rxdev review`) — review staged changes or PRs before committing
- **Contextual Commits** — uses branch name, recent commits, and GitHub Issues for better messages
- **Analytics** (`rxdev analytics`) — commit statistics and bad practice detection
- **Smart Split** — auto-detects file types (tests, docs, config) for intelligent grouping
- **Config as Code** — `rxdev.yml` in your project root for team-shared settings
- **GitHub Action** — automatic AI review on every PR
- **Improved Diff System** — smart truncation (16K chars), never cuts files mid-way
- **Cross-platform CI** — tested on Windows, macOS, and Ubuntu

---

## Features

### QuickFlow (`rxdev go`)

The flagship workflow. Stage, generate, review, push in one command:

```
$ rxdev go
```

1. **Stage** — interactively choose files to include
2. **Generate** — AI analyses the diff and streams a Conventional Commit message in real-time
3. **Review** — see the message, choose what to do next
4. **Push** — accept and push, or edit, regenerate, or cancel

### AI Code Review (`rxdev review`)

Get instant feedback on your staged changes:

```
$ rxdev review
```

- Analyzes code for bugs, security issues, and performance problems
- Provides severity ratings (critical/warning/suggestion)
- Works on staged changes or PR diffs

### Contextual Commits

Commit messages that understand your workflow:

- **Branch context** — knows you're on `feature/user-auth`
- **Recent history** — considers the last 3 commits
- **GitHub Issues** — auto-links to issues from branch names (`fix/123`, `feature/PROJ-456`)

### Smart Split (`rxdev split`)

Split large changes into logical commits:

```
$ rxdev split
```

- Auto-detects test files → `test:` commits
- Auto-detects docs → `docs:` commits
- Auto-detects config files → `chore:` commits
- LLM handles the rest for intelligent grouping

### Analytics (`rxdev analytics`)

Understand your commit patterns:

```
$ rxdev analytics
```

- Commit statistics by type
- Average message length
- Breaking change detection
- Bad practice warnings (too long, non-conventional, etc.)

### GitHub Action

Automatic AI review on every PR — uses your existing provider key:

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
          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
          # or OPENAI_API_KEY, OPENROUTER_API_KEY — whichever you use
```

### Other Features

- **Auto-bump version** — discovers 15+ manifest formats (package.json, Cargo.toml, pyproject.toml, etc.)
- **Secret scanning** — detects leaked credentials in staged changes
- **PR generation** — creates PR titles and descriptions from commits
- **GitHub Releases** — creates releases with tags from conventional commits
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

That's it. `rxdev go` guides you through every step:

1. **Choose files to stage** — or press Enter to stage all
2. **AI generates the message** — streamed live to your terminal
3. **Review loop** — decide what to do:
   - **Push** — accept and push immediately
   - **Edit message** — open `$EDITOR` and amend
   - **Regenerate** — ask the model for a new suggestion
   - **Cancel** — soft-reset and abort
4. **Push** — select remote and branch interactively from lists

---

## Commands

| Command | Description |
|---------|-------------|
| `rxdev go` | **QuickFlow** — stage → scan → generate → review → push |
| `rxdev review` | AI code review of staged changes |
| `rxdev split` | Split staged changes into multiple logical commits |
| `rxdev scan` | Scan staged changes for leaked secrets |
| `rxdev stats` | Show commit statistics and bad practices |
| `rxdev tokens` | Show token usage statistics |
| `rxdev pr` | Generate a pull request title + description |
| `rxdev release` | Create GitHub Release with tag |
| `rxdev init` | Install the AI commit hook |
| `rxdev config` | Configure provider, model, language, and more |
| `rxdev status` | Show integration status |
| `rxdev doctor` | Diagnose your setup |
| `rxdev filter` | Rewrite git history |
| `rxdev uninstall` | Remove the hook |
| `rxdev version` | Show version number |
| `rxdev update` | Update to latest version |

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
| `GROQ_API_KEY` | Groq API key (default provider) |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |

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

Automatic AI review on every PR — uses your existing provider key:

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
          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
          # or OPENAI_API_KEY, OPENROUTER_API_KEY — whichever you use
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](./docs/architecture.md) | High-level overview of the CLI + git-hook architecture |
| [Auto-bump](./docs/auto-bump.md) | Smart version bumping for 15+ manifest formats |
| [Templates & Projects](./docs/templates.md) | Multi-repository management and shared templates |

---

## License

**MIT** — see [LICENSE](./LICENSE) for details.
