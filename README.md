# 🧠 NeuroCommit

<div align="center">

**AI-powered conventional commit message generator**

[Installation](#installation) • [Features](#features) • [Configuration](#configuration) •  [Quick Start](#quick-start)

</div>

<div align="center">

  <a href="./docs/languages/ru-RU.md">Русский</a>

</div>

NeuroCommit is a command-line tool that writes [Conventional Commits](https://www.conventionalcommits.org/)-style messages for you from your staged diff, so you can stop thinking about commit wording and just commit.

> [!NOTE]
> Commit messages are generated via the [Groq API](https://console.groq.com) — fast inference on Llama 3.1 8B with streaming.  
> You need a free API key from [console.groq.com](https://console.groq.com). Set it via `qq config`.

## Features

- 🤖 **AI-generated messages** — Conventional Commits subject in English + body in Russian explaining *why*, derived from your staged diff.
- 📈 **Smart Auto-bump version** (opt-in) — intelligently discovers manifests across the entire repo, not just the root. Supports 15+ manifest types:
  - `package.json`, `composer.json` (JSON parser)
  - `Cargo.toml`, `pyproject.toml` (TOML parser)
  - `pubspec.yaml`, `Chart.yaml`, `*.gemspec`, `setup.cfg`
  - `build.gradle`, `*.csproj`, `VERSION`, `version.txt`
  - And more — auto-detected by file name.
  - `feat:` → minor, `!` or `BREAKING CHANGE` → major, everything else → patch
  - **Monorepo support** — finds manifests in subdirectories automatically
  - **Pre-release safe** — preserves `-alpha.1`, `+build` suffixes
  - **Merge-safe** — if a manifest is already staged, reads it from the index and bumps on top
  - **Change-aware** — skips bump if changed files are unrelated to the package (e.g., docs-only changes in a different directory)
  - **Git tag aware** — falls back to latest semver tag if manifest has no version
- ✏️ **Edit before commit** — `qq go` lets you review, regenerate, or open `$EDITOR` to tweak the message before pushing.
- 📂 **Multi-project** — manage hooks and shared templates across several repos from one place.
- 🚫 **Ignore list** — `.commitignore` works like `.gitignore`; matching files are excluded from the diff sent to the model.

## Installation

#### Login to pnpm
1. Get the PAT key from your account at [link](https://github.com/settings/tokens) with the right `write:packages`

```bash
# 2. Login to pnpm
pnpm login --scope=@rxgodev --registry=https://npm.pkg.github.com/
```

3. Enter your username and token (to the "Password" field)

#### Install from pnpm

```bash
pnpm add -g @rxgodev/neuro-commit@latest
```

NeuroCommit was successfully installed 🎉

## Configuration

```bash
qq config
```

In the menu:

- **✅ Save & exit** — exit the menu (always the first option)

Settings:
- **🧠 Model** — switch between Llama 3.1 **8B** (faster, 560 t/s) and **70B** (smarter, 280 t/s).
- **✏️ Custom prompt** — override the system prompt. Opens `$EDITOR` for multiline editing.  
  Use `{types}` as a placeholder — it will be replaced with the actual list of allowed types (e.g. `feat, fix, chore, docs, style, refactor, perf, test, build, ci, revert` plus any custom types you add).  
  Example custom prompt:
  ```
  You are a git commit generator. Allowed types: {types}.
  Subject in English, body in Russian.
  ```
- **📝 Custom types** — add extra Conventional Commits types beyond the built-in ones.  
  Example: `hotfix, deps, i18n, ui, api, db`. These get added to the `{types}` list in prompts and are accepted by commit validation.
- **🔑 API key** — set or clear your Groq API key from [console.groq.com](https://console.groq.com).  
  API key is required for Groq (get one free).
- **👥 Co-author** — toggle the `Co-authored-by` trailer in commit messages.
- **📈 Auto-bump version** — toggle smart automatic version bumps for 15+ manifest types (JSON, TOML, YAML, XML, Gradle, plain text). Off by default.
- **📂 Projects & Templates** — list integrated projects and manage shared `prepare-commit-msg` templates.

#### .commitignore

Edit `.commitignore` like `.gitignore` to exclude files from the diff sent to the model. By default, files related to `.githooks` are listed there.

## Quick Start

```bash
# Install the hook in this repo
qq init

# Stage and commit — message is generated automatically
git add .
git commit

# Or use the guided flow (stage + commit + review + push)
qq go
```

In `qq go`, after the message is generated you can:
- ✅ **Push** — accept and push
- ✏️ **Edit message** — open `$EDITOR` and amend
- 🔄 **Regenerate** — ask the model again
- ❌ **Cancel** — soft-reset and abort

## Commands

| Command | Description |
|---|---|
| `qq init` | Install the AI commit hook in the current repo |
| `qq go` | Guided flow: stage → commit → review → push |
| `qq config` | Configure API key, co-author, auto-bump, projects, templates |
| `qq status` | Show integration status for this repo |
| `qq uninstall` | Remove the hook from this repo |

## License

[LICENSE](./LICENSE)
