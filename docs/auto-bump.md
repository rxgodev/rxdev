# Automatic Version Bumping

When enabled, NeuroCommit automatically detects version manifests in your repository and bumps them according to the generated commit message.

> **Opt-in**: disabled by default. Enable via `qq config` → **Auto-bump**.

## How It Works

1. **Parse commit message** — determine bump type from the generated Conventional Commit:
   - `feat:` → **minor** bump
   - `!` or `BREAKING CHANGE` → **major** bump
   - Everything else → **patch** bump

2. **Discover manifests** — scan the entire repository tree (not just the root) for known version files.

3. **Read and bump** — parse each manifest's semver version, apply the bump, and write the new version back.

4. **Amend commit** — a background process waits for the initial commit, then amends it with the bumped manifest files staged.

## Supported Manifest Formats

| Format | Files | Parser |
|--------|-------|--------|
| **JSON** | `package.json`, `composer.json` | `json.loads` — reads `version` field |
| **TOML** | `Cargo.toml`, `pyproject.toml` | `tomllib` (Python 3.11+) or regex fallback — reads `[project].version` or `[tool.poetry].version` |
| **YAML** | `pubspec.yaml`, `Chart.yaml` | Regex — reads `version:` field |
| **Gradle** | `build.gradle`, `build.gradle.kts` | Regex — reads `version = "..."` |
| **.NET** | `*.csproj`, `Version.props`, `Directory.Build.props` | Regex — reads `<Version>` or `<PackageVersion>` |
| **Gemspec** | `*.gemspec` | Regex — reads `.version = "..."` |
| **Plain text** | `VERSION`, `version.txt`, `setup.cfg`, `.bumpversion.cfg` | First line or `version =` |
| **Helm** | `Chart.yaml` | Regex — reads `version:` and `appVersion:` |

## Monorepo Support

NeuroCommit discovers manifests recursively across the entire repository. If you have:

```
my-monorepo/
  packages/
    frontend/package.json
    backend/Cargo.toml
  Chart.yaml
```

All three will be bumped in a single commit.

## Change Awareness

The bump system is smart about which manifests to bump:

- **`docs`** changes only bump manifests in directories that have staged documentation changes
- **`style`** changes only bump manifests in directories that have staged style changes
- **`test`** changes only bump manifests in directories that have staged test changes
- **All other types** (`feat`, `fix`, `refactor`, etc.) bump every discovered manifest
- If staged changes are unrelated to a package's directory, that manifest is skipped

## Pre-release Safety

Pre-release suffixes are preserved during bumps:

| Before | Bump | After |
|--------|------|-------|
| `1.0.0-alpha.1` | minor | `1.1.0-alpha.1` |
| `2.3.5+build.42` | patch | `2.3.6+build.42` |
| `0.9.0-rc.1` | major | `1.0.0-rc.1` |

## Merge Safety

If a manifest is already staged (e.g., an earlier manual version bump), NeuroCommit reads it from the Git index and applies the bump on top, avoiding conflicts.

## Git Tag Awareness

If a manifest file has no `version` field, NeuroCommit falls back to the latest semver-compatible Git tag (prefix `v` optional):

```
v1.2.3  →  parsed as 1.2.3
1.0.0   →  parsed as 1.0.0
release-2.1.0  →  skipped (no semver match)
```

## Bump Rules

| Conventional Commit | Bump |
|--------------------|------|
| `feat:` | minor |
| `feat!:`, `feat(scope)!:` | major |
| `fix:` | patch |
| `chore:`, `docs:`, `style:`, `refactor:`, `perf:`, `test:`, `build:`, `ci:`, `revert:` | patch |
| Any commit with `BREAKING CHANGE:` in body | major |

## Example

```
# Generated commit message
feat(api): add user authentication endpoint

Добавлен новый эндпоинт /auth/login для аутентификации пользователей.
Реализована проверка JWT-токенов в middleware.

# Auto-bump output
[+] Bumped package.json: 1.2.3 → 1.3.0 (minor)
[+] Bumped Chart.yaml: 1.2.3 → 1.3.0 (minor)
```
