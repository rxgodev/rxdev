# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Improved performance with optimized manifest discovery
- Better error handling and logging

### Fixed
- Critical bug: `process.exit(0)` on fatal hook errors now exits with code 1
- Security: Log file now writes to user config directory instead of project root
- Security: Temporary files now use random names to prevent symlink attacks
- Error handling: `spawnAsync` now includes error handler and timeout
- Windows compatibility: Fixed test imports to use file:// URLs