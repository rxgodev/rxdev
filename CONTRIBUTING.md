# Contributing to RXDev

Thank you for considering contributing! Here's how to get started.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/rxgodev/rxdev.git
cd rxdev

# Install dependencies
npm install

# Make your changes, then test
node bin/ac.js --help
```

## Code Style

- Follow existing conventions in the codebase
- JavaScript: 2-space indentation, semicolons
- Use Biome for formatting and linting: `npm run format` and `npm run lint`
- Keep functions focused and small

## Before Submitting

1. Run tests: `npm test`
2. Run linter: `npm run lint`
3. Test your changes manually:
   - `node bin/ac.js status`
   - `node bin/ac.js --help`
4. Update documentation (README, translations in `docs/languages/`) if your change affects user-facing features

## Pull Request Process

1. Fork the repo and create your branch from `main`
2. If you've added new functionality, update the README and translations
3. Ensure the CLI help text stays in sync with command changes
4. Open a PR with a clear title and description

## Reporting Issues

Open an issue at https://github.com/rxgodev/rxdev/issues with:
- A clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Your OS and Node.js version
