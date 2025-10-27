# 🧠 Auto Commit

<div align="center">

**AI-powered generator comments for your commits**

[Installation](#installation) • [Configuration](#configuration) •  [Quick Start](#quick-start) • [Updating](#updating)

</div>

<div align="center">

  <a href="./docs/languages/ru-RU.md">Русский</a>

</div>

Auto Commit is a powerful AI command-line CLI for creating comments on your commits. This allows you not to think about changes in your code, not to study the rules of writing comments, but just to enjoy.

> [!WARNING]
> **Token Usage Notice**: We use a free solution from [io.net](https://io.net). All tokens used are spent in their API. The limits are restored daily.

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
pnpm add -g @rxgodev/ac@latest
```

Auto Commit was successfully installed 🎉

## Configuration

#### After [installation](#installation), get the API key from the [link](https://ai.io.net/ai/api-keys). Then use the following command and enter this key there

```bash
qq config
```

#### You can set up files that should not be described by AI

Edit `.commitignore` like `.gitignore`. By default, files related to `.githooks` are embedded there.

## Quick Start

> [!NOTE]
> The code uses 6 AI models, each of which uses 500,000 tokens. This allows you to make up to ~6000 commits per day.

```bash
# Initialization git hooks in directory
qq init

# Get the API key from https://ai.io.net/ai/api-keys and enter it in field
# Then use this:
git add .
git commit

# Read the comment, add or change your points if necessary
:wq # Command for Save + Exit from file
git push
```

## Updating

#### Install latest version from pnpm

```bash
pnpm add -g @rxgodev/ac@latest
```

The update was successfully installed 🎉
P.S. Updates are installed automatically whenever you interact with `qq`

## License

[LICENSE](./LICENSE)
