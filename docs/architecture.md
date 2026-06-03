# Architecture

NeuroCommit consists of two runtime layers that work together to generate AI-powered commit messages.

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      User (CLI)                             │
│      qq go  ← flagship   │   qq init │ qq config │ ...     │
└───────────────────┬─────────────────────────────────────────┘
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
┌──────────────────┐  ┌──────────────────┐
│  QuickFlow       │  │  Hook Mode       │
│  (interactive)   │  │  (automatic)     │
│                  │  │                  │
│  qq go           │  │  qq init         │
│  1. stage        │  │  → git commit    │
│  2. generate     │  │  → hook fires    │
│  3. review       │  │  → AI generates  │
│  4. push         │  │  → message saved │
└────────┬─────────┘  └────────┬─────────┘
         │                     │
         └─────────┬───────────┘
                   ▼
┌─────────────────────────────────────────────────────────────┐
│              Node.js CLI  (bin/ac.js)                        │
│                                                              │
│  - Package management & updates (update-notifier)            │
│  - QuickFlow orchestration (stage → generate → push)        │
│  - Git hook installation & removal                           │
│  - Interactive configuration (inquirer)                      │
│  - Multi-project management                                  │
│  - Template system for prepare-commit-msg scripts            │
└───────────────┬─────────────────────────────────────────────┘
                │  spawns (git commit → prepare-commit-msg hook)
                ▼
┌─────────────────────────────────────────────────────────────┐
│              Python Hook  (.githooks/ai_commit.py)           │
│                                                              │
│  - Reads staged diff via git                                 │
│  - Calls Groq API (streaming)                                │
│  - Generates Conventional Commit message                     │
│  - Validates & cleans LLM response                           │
│  - Fallback generator (no API key)                           │
│  - Smart version auto-bump (15+ manifest formats)            │
│  - Co-authored-by trailer                                    │
└─────────────────────────────────────────────────────────────┘
```

## Layer 1: Node.js CLI (`bin/ac.js`)

The CLI is the user-facing entry point. It is a single-file ESM module (~1160 lines) that handles:

### Commands

| Command | Responsibility |
|---------|---------------|
| `qq init` | Install Python dependencies, copy hooks to `.githooks/`, set `core.hooksPath`, create `.commitignore`, register project |
| `qq go` | **QuickFlow** — the flagship workflow. Interactive session: stage → generate → review → push. Eliminates context-switching between git commands |
| `qq config` | Interactive menu for model, prompt, API key, co-author, auto-bump, custom types, projects & templates |
| `qq status` | Check hook installation state, API key status, auto-bump config |
| `qq uninstall` | Remove `.githooks/` directory, reset `core.hooksPath`, unregister project |

### Auto-update Mechanism

On every `qq` command (except `uninstall`), the CLI:

1. Reads `~/.config/ai-commit/managed-projects.json` for registered projects
2. For each project, compares the installed `ai_commit.py` hash/version with the bundled one
3. If outdated, replaces the hook file and updates its `.sha256` checksum

This ensures all managed projects stay in sync with the latest hook version.

### Configuration Storage

All configuration is stored in `~/.config/ai-commit/`:

| File | Purpose |
|------|---------|
| `config.json` | API key, model, prompt, custom types, co-author, bump toggle |
| `managed-projects.json` | List of registered project paths |
| `templates.json` | Named `prepare-commit-msg` templates with applied-to tracking |

## QuickFlow Deep Dive

QuickFlow (`qq go`) is the flagship workflow, designed to minimise friction. Unlike hook mode (where `git commit` triggers AI generation), QuickFlow is an **interactive session** that controls the entire lifecycle:

### Session Flow

```
qq go
 │
 ├── Step 1: Stage ──────────────────────────────────
 │   Prompt: "git add <path>" (default: .)
 │   → git add <path>
 │   → Show staged file count
 │
 ├── Step 2: Generate ───────────────────────────────
 │   → git commit --quiet (triggers ai_commit.py hook)
 │   → AI streams message to stdout in real-time
 │   → Read generated message from .git/COMMIT_EDITMSG
 │   → Display in a clean review UI
 │
 ├── Step 3: Review Loop ────────────────────────────
 │   ┌─ Push ───────→ accept & proceed to push
 │   ├─ Edit ───────→ open $EDITOR → amend commit → re-display
 │   ├─ Regenerate ─→ git reset --soft HEAD~1 → re-run hook
 │   └─ Cancel ─────→ git reset --soft HEAD~1 → exit
 │
 └── Step 4: Push ──────────────────────────────────
     Prompt: "git push <remote> <branch>" (default: origin main)
     → git push
     → success message
```

### Key Design Decisions

- **Single process** — unlike hook mode, QuickFlow owns the terminal session. No editor popup, no manual `git push` later.
- **Regenerate resets** — `git reset --soft HEAD~1` undoes the commit but keeps staged files intact, so the hook can run again.
- **Edit uses $EDITOR** — falls back to `notepad` (Windows) or `vi` (Unix).
- **Push defaults** — `origin main` by default, customisable per session.
- **Streaming feedback** — the AI response is printed character-by-character as it arrives, so the user never waits in silence.

### When to Use QuickFlow vs Hook Mode

| Scenario | Recommended |
|----------|-------------|
| Daily development, want fast cycle | `qq go` |
| IDE integration (commit via VSCode etc.) | Hook mode (`qq init`) |
| CI / automated commits | Hook mode |
| Complex diffs needing review | `qq go` (review loop) |
| New to the tool | `qq go` (guided experience) |

---

## Layer 2: Python Hook (`ai_commit.py`)

A Python 3.8+ script that runs as a `prepare-commit-msg` Git hook. It is single-file (~1230 lines) with no external dependencies except `pathspec` (installed automatically by `qq init`).

### Execution Flow

1. **Read commit file** — if non-empty (user-provided message), skip AI generation
2. **Check for .husky** — refuses to run alongside husky
3. **Get staged diff** — `git diff --cached` filtered through `.commitignore` (via `pathspec`)
4. **Call Groq API** — streaming response with up to 3 retry attempts
5. **Validate** — checks Conventional Commits format, retries if invalid
6. **Fallback** — if all API attempts fail, generates a deterministic message based on file extensions and paths
7. **Auto-bump** (opt-in) — discovers manifests, bumps version, amends commit
8. **Co-author** — appends `Co-authored-by` trailer
9. **Write commit file** — saves the final message

### Model Selection

Two Groq-hosted models are available:

| Model | ID | Speed | Use Case |
|-------|-----|-------|----------|
| Llama 3.1 8B | `llama-3.1-8b-instant` | ~560 t/s | Faster, daily commits |
| Llama 3.3 70B | `llama-3.3-70b-versatile` | ~280 t/s | Smarter, complex diffs |

### Streaming

The Groq API is called with `stream: true`. Each content chunk is written to stdout in real-time, giving the user immediate feedback. After streaming completes, the full response is cleaned and validated.

### Response Cleaning (`_clean_llm_response`)

The LLM output goes through sanitisation:

- Strips markdown (`**`, `` ` ``, `#`)
- Removes leading explanatory lines ("Here is", "Response:", etc.)
- Normalises type casing (`Feat:` → `feat:`)
- Ensures subject ≤ 150 chars
- Falls back to `chore:` prefix if no valid type detected

### Fallback Generator (`generate_fallback_message`)

Triggered when the API is unreachable, rate-limited, or all retries return invalid messages. It:

- Analyses file extensions (`.py` → `refactor`, `.md` → `docs`, etc.)
- Detects scope from directory structure
- Generates a descriptive body listing changed files by directory

---

## Git Hook Integration

The chain is:

1. `qq init` sets `git config core.hooksPath .githooks`
2. On `git commit`, Git executes `.githooks/prepare-commit-msg`
3. The shell script runs `python .githooks/ai_commit.py "$1"`
4. `ai_commit.py` writes the generated message to the commit file
5. Git opens the editor (or skips it if `GIT_EDITOR=true`)

## Dependency Summary

| Layer | Runtime | External Dependencies |
|-------|---------|-----------------------|
| CLI | Node.js ≥ 22 | `inquirer`, `update-notifier` |
| Hook | Python 3.8+ | `pathspec` (auto-installed) |
| API | — | Groq account (free tier available) |
