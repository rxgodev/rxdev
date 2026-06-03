<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white" alt="Node version">
  <img src="https://img.shields.io/badge/version-2.15.3-8250df" alt="Version">
  <img src="https://img.shields.io/badge/cli-qq-4FC08D?logo=gnubash&logoColor=white" alt="CLI">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/badge/provider-Groq-FF6C2C?logo=groq&logoColor=white" alt="Groq">
  <img src="https://img.shields.io/badge/model-Llama%203.1%2F3.3-8250df" alt="Llama 3.1/3.3">
</p>

# NeuroCommit

> **QuickFlow** — the fastest path from `git add` to a perfect commit. Stage, generate, review, push. All in one command.

**AI-powered Conventional Commit message generator** — analyses your staged diff and produces meaningful, standardised commit messages via [Groq](https://console.groq.com) (powered by Meta Llama 3.1/3.3). Works as a Git hook, interactive CLI, or standalone generator.

<p align="center">
  <a href="https://github.com/rxgodev/neuro-commit#readme"><b>Documentation</b></a>
  ·
  <a href="https://github.com/rxgodev/neuro-commit/issues"><b>Report a Bug</b></a>
  ·
  <a href="./docs/languages/ru-RU.md">Русский</a>
  ·
  <a href="./docs/languages/zh-CN.md">中文</a>
  ·
  <a href="./docs/languages/de-DE.md">Deutsch</a>
  ·
  <a href="./docs/languages/fr-FR.md">Français</a>
</p>

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Commands](#commands)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [License](#license)

---

## Features

### 🚀 QuickFlow (`qq go`)

The flagship workflow. A single command that takes you from dirty working tree to pushed commit:

```
$ qq go
```

1. **Stage** — interactively choose files to include
2. **Generate** — AI analyses the diff and streams a Conventional Commit message in real-time
3. **Review** — see the message, choose what to do next
4. **Push** — accept and push, or edit, regenerate, or cancel

QuickFlow eliminates context-switching. No more `git add → git commit → wait → git push`. Everything happens in one seamless session.

---

### Core Features

- **AI-generated commit messages** — a Conventional Commits subject in English plus a body in Russian explaining *why*, derived entirely from your staged diff.
- **Auto-bump version (opt-in)** — intelligently discovers version manifests across the entire repository (monorepo-safe). Supports 15+ formats:
  - `package.json`, `composer.json` — JSON parser
  - `Cargo.toml`, `pyproject.toml` — TOML parser
  - `pubspec.yaml`, `Chart.yaml`, `*.gemspec`, `setup.cfg`
  - `build.gradle`, `*.csproj`, `VERSION`, `version.txt`
  - Auto-detected by file name; no configuration needed.
  - `feat:` → **minor** bump, `!` / `BREAKING CHANGE` → **major**, everything else → **patch**
  - Pre-release safe — preserves `-alpha.1`, `+build` suffixes.
  - Merge-safe — reads already-staged manifests from the index.
  - Change-aware — skips bump when changed files are unrelated to the package.
  - Git-tag aware — falls back to the latest semver tag when no manifest version exists.
- **Edit before commit** — review, regenerate, or open `$EDITOR` to tweak the message before it lands.
- **Multi-project** — manage hooks and shared `prepare-commit-msg` templates across several repositories from one place.
- **Ignore list** — `.commitignore` works like `.gitignore`; matching files are excluded from the diff sent to the model.

---

## Installation

### Prerequisites

- **Node.js** >= 22
- A **free API key** from [console.groq.com](https://console.groq.com)

### 1. Set up GitHub Package Registry

```bash
pnpm login --scope=@rxgodev --registry=https://npm.pkg.github.com/
```

Enter your GitHub username and a [personal access token](https://github.com/settings/tokens) with `write:packages` scope when prompted (token goes in the "Password" field).

### 2. Install globally

```bash
pnpm add -g @rxgodev/neuro-commit@latest
```

### 3. Configure your API key

```bash
qq config
```

Navigate to **API key** in the menu and paste your Groq key.

---

## Quick Start

After installing, get your first AI-powered commit in seconds:

```bash
# Install the hook (one time per repo)
qq init

# QuickFlow — stage, generate, review, push
qq go
```

That's it. `qq go` guides you through every step:

1. **Choose files to stage** — or press Enter to stage all
2. **AI generates the message** — streamed live to your terminal
3. **Review loop** — decide what to do:
   - **Push** — accept and push immediately
   - **Edit message** — open `$EDITOR` and amend
   - **Regenerate** — ask the model for a new suggestion
   - **Cancel** — soft-reset and abort
4. **Push** — specify remote/branch or accept defaults

> QuickFlow is the recommended workflow. For Git hook integration (automatic generation via `git commit`), see `qq init`.

---

## Commands

| Command          | Description |
|------------------|-------------|
| `qq go`          | **QuickFlow** — stage → generate → review → push (recommended) |
| `qq init`        | Install the AI commit hook in the current repository |
| `qq config`      | Configure API key, model, co-author, auto-bump, projects, and templates |
| `qq status`      | Show integration status for the current repository |
| `qq uninstall`   | Remove the hook from the repository |

---

## Configuration

```bash
qq config
```

### Settings

| Setting             | Description |
|---------------------|-------------|
| **Model**           | Switch between Llama 3.1 **8B** (faster, ~560 t/s) and **70B** (smarter, ~280 t/s) |
| **Custom prompt**   | Override the system prompt. Use `{types}` as a placeholder — it is replaced with the allowed commit types (e.g. `feat, fix, chore, docs, style, refactor, perf, test, build, ci, revert` plus any custom types you add) |
| **Custom types**    | Add extra Conventional Commits types beyond the built-in set (e.g. `hotfix, deps, i18n, ui, api, db`) |
| **API key**         | Set or clear your Groq API key |
| **Co-author**       | Toggle the `Co-authored-by` trailer in commit messages |
| **Auto-bump**       | Toggle automatic version bumps for 15+ manifest types (off by default) |
| **Projects & Templates** | List integrated projects and manage shared `prepare-commit-msg` templates |

### .commitignore

Edit `.commitignore` (which follows `.gitignore` syntax) to exclude files from the diff sent to the model. By default, `.githooks` entries are listed there.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](./docs/architecture.md) | High-level overview of the Node.js CLI + Python hook architecture |
| [Auto-bump](./docs/auto-bump.md) | Smart version bumping for 15+ manifest formats |
| [Templates & Projects](./docs/templates.md) | Multi-repository management and shared hook templates |

---

## License

**MIT** — see [LICENSE](./LICENSE) for details.
