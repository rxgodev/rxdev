# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.1.0] - 2026-06-13

### Added
- Cross-platform CI testing (Windows, macOS, Ubuntu)
- Biome linting and formatting for consistent code style
- CLI smoke tests and unit tests
- Code coverage reporting with c8
- `.gitattributes` to enforce LF line endings across platforms
- `CHANGELOG.md` for tracking project changes

### Changed
- Optimized `discoverManifests` with single-pass matching and caching
- Improved error handling with logging for unparseable patterns and malformed SSE chunks
- Moved log file from project root to `~/.config/ai-commit/`
- Temp files now use random names instead of predictable PID-based names
- Removed `shell: true` from `spawnSync` calls for better security

### Fixed
- Critical: `process.exit(0)` on fatal hook errors now exits with code 1
- Critical: `spawnAsync` now includes error handler and timeout to prevent hangs
- Critical: `prCommand` now properly accepts `--base` argument parameter
- Security: Log file no longer pollutes project root
- Security: Temp files are no longer vulnerable to symlink attacks
- Windows: Fixed test imports to use `file://` URLs
- Windows: Fixed CI smoke test that used Linux-only `/dev/null`
- Guarded `getStagedDiff` against wrong working directory

## [3.0.0] - 2025-01-01

### Added
- AI-powered commit message generation using LLM providers (Groq, OpenAI, OpenRouter, Ollama)
- Interactive CLI with commands: `qq go`, `qq split`, `qq scan`, `qq pr`, `qq release`, `qq init`, `qq config`, `qq status`, `qq doctor`, `qq filter`, `qq uninstall`, `qq version`, `qq update`
- Git hook integration via `prepare-commit-msg`
- Support for conventional commits with customizable types
- Multi-language support (English, Russian, German, French, Chinese)
- Version bumping for multiple manifest formats (package.json, pyproject.toml, Cargo.toml, etc.)
- Secret scanning in staged changes
- PR description generation
- Changelog generation
- Template system for multi-project setups

### Changed
- Complete rewrite from Python to Node.js (ESM)
- Zero external dependencies for the git hook layer
