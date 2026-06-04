<div align="center">

# NeuroCommit

**AI 驱动的 Git 提交生成器** — 暂存、生成、审查、推送，一条命令搞定。

[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-2.17.0-8250df)](https://github.com/rxgodev/neuro-commit/releases)
[![CLI](https://img.shields.io/badge/cli-qq-4FC08D?logo=gnubash&logoColor=white)](.#readme)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Groq](https://img.shields.io/badge/provider-Groq-FF6C2C?logo=groq&logoColor=white)](https://console.groq.com)
[![Model](https://img.shields.io/badge/model-Llama%203.1%2F3.3-8250df)](.#readme)

[文档](https://github.com/rxgodev/neuro-commit#readme) · [报告错误](https://github.com/rxgodev/neuro-commit/issues) ·
[English](https://github.com/rxgodev/neuro-commit/blob/main/README.md)

</div>

---

## 目录

- [功能特性](#功能特性)
- [安装](#安装)
- [快速开始](#快速开始)
- [命令](#命令)
- [配置](#配置)
- [文档](#文档)
- [许可证](#许可证)

---

## 功能特性

### 🚀 QuickFlow (`qq go`)

旗舰工作流程。一条命令从脏工作目录到已推送的提交：

```
$ qq go
```

1. **暂存** — 交互式选择要提交的文件
2. **生成** — AI 分析差异并实时流式输出 Conventional Commit 消息
3. **审查** — 查看消息，选择下一步操作
4. **推送** — 接受并推送，或编辑、重新生成、取消

QuickFlow 消除了上下文切换。不再需要 `git add → git commit → wait → git push`。一切都在一个无缝会话中完成。

---

### 核心功能

- **AI 生成提交消息** — 基于您的暂存区差异，生成英文 Conventional Commits 标题和所选语言的正文（解释*为什么*修改）。支持中文、英文、俄文、德文和法文。
- **自动版本递增（可选）** — 智能发现整个仓库中的版本清单（支持单仓库）。支持 15+ 格式：
  - `package.json`、`composer.json` — JSON 解析器
  - `Cargo.toml`、`pyproject.toml` — TOML 解析器
  - `pubspec.yaml`、`Chart.yaml`、`*.gemspec`、`setup.cfg`
  - `build.gradle`、`*.csproj`、`VERSION`、`version.txt`
  - 按文件名自动检测，无需配置。
  - `feat:` → **minor** 递增，`!` / `BREAKING CHANGE` → **major**，其余 → **patch**
  - 预发布安全 — 保留 `-alpha.1`、`+build` 后缀。
  - 合并安全 — 如果清单已在暂存区，则从索引读取并递增。
  - 变更感知 — 若更改文件与包无关则跳过递增。
  - Git 标签感知 — 当清单无版本号时回退到最新 semver 标签。
- **提交前编辑** — 查看、重新生成或打开 `$EDITOR` 调整消息。
- **多项目** — 从同一位置管理多个仓库的钩子和共享 `prepare-commit-msg` 模板。
- **忽略列表** — `.commitignore` 类似于 `.gitignore`；匹配的文件将从发送给模型的差异中排除。

---

## 安装

### 前置要求

- **Node.js** >= 18
- **免费 API 密钥** 来自 [console.groq.com](https://console.groq.com)

### 1. 配置 GitHub Package Registry

```bash
pnpm login --scope=@rxgodev --registry=https://npm.pkg.github.com/
```

输入您的 GitHub 用户名和[个人访问令牌](https://github.com/settings/tokens)（需要 `write:packages` 权限），令牌填入 "Password" 字段。

### 2. 全局安装

```bash
pnpm add -g @rxgodev/neuro-commit@latest
```

### 3. 配置 API 密钥

```bash
qq config
```

在菜单中选择 **API key** 并粘贴您的 Groq 密钥。

---

## 快速开始

```bash
# 安装钩子（每个仓库只需一次）
qq init

# QuickFlow — 暂存、生成、审查、推送
qq go
```

就这么简单。`qq go` 引导您完成每一步：

1. **选择要暂存的文件** — 或按 Enter 暂存所有
2. **AI 生成消息** — 实时流式输出到终端
3. **审查循环** — 决定下一步：
   - **Push** — 接受并立即推送
   - **Edit message** — 打开 `$EDITOR` 修改
   - **Regenerate** — 请模型重新生成
   - **Cancel** — 软重置并取消
4. **推送** — 指定远程/分支或接受默认值

> QuickFlow 是推荐的工作流程。如需 Git 钩子集成（通过 `git commit` 自动生成），请使用 `qq init`。

---

## 命令

| 命令            | 说明 |
|-----------------|------|
| `qq go`         | **QuickFlow** — 暂存 → 生成 → 审查 → 推送（推荐） |
| `qq init`       | 在当前仓库安装 AI 提交钩子 |
| `qq config`     | 配置 API 密钥、模型、语言、co-author、自动递增、项目和模板 |
| `qq status`     | 显示当前仓库的集成状态 |
| `qq uninstall`  | 从仓库移除钩子 |
| `qq version`    | 显示版本号 |
| `qq update`     | 显示更新说明 |
| `qq --no-color` | 禁用 ANSI 颜色（也支持 `NO_COLOR` 环境变量） |

---

## 配置

```bash
qq config
```

### 设置

| 设置                | 说明 |
|---------------------|------|
| **Model**           | 切换模型：Llama 3.1 **8B**（更快，~560 t/s）或 **70B**（更智能，~280 t/s） |
| **Language**        | 提交正文的语言：中文、英文、俄文、德文或法文 |
| **Custom prompt**   | 覆盖系统提示词。使用 `{types}` 作为占位符 — 将被替换为允许的提交类型列表（feat, fix, chore, docs, style, refactor, perf, test, build, ci, revert 以及您添加的自定义类型） |
| **Custom types**    | 添加内置类型之外的自定义 Conventional Commits 类型（例如 `hotfix, deps, i18n, ui, api, db`） |
| **API key**         | 设置或清除您的 Groq API 密钥 |
| **Co-author**       | 在提交消息中切换 `Co-authored-by` 尾注 |
| **Auto-bump**       | 切换 15+ 种清单类型的自动版本递增（默认关闭） |
| **Projects & Templates** | 列出已集成的项目并管理共享的 `prepare-commit-msg` 模板 |

### .commitignore

编辑 `.commitignore`（语法与 `.gitignore` 相同）以从发送给模型的差异中排除文件。默认情况下其中列出了 `.githooks` 相关条目。

---

## 文档

| 文档 | 描述 |
|------|------|
| [架构](./architecture.md) | Node.js CLI + Python 钩子架构概览 |
| [自动递增](./auto-bump.md) | 15+ 种清单格式的智能版本递增 |
| [模板和项目](./templates.md) | 多仓库管理和共享钩子模板 |

---

## 许可证

**MIT** — 详见 [LICENSE](./LICENSE)。
