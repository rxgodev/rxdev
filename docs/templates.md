# Templates & Multi-Project Management

rxcommit supports managing several repositories from a single installation, with shared `prepare-commit-msg` hook templates.

## Managed Projects

When you run `qq init` in a repository, it is registered in `~/.config/ai-commit/managed-projects.json`. This enables:

- **Auto-update** — hooks are automatically updated across all registered projects when rxcommit is upgraded
- **Status overview** — `qq status` shows integration state for the current repository
- **Template application** — templates can be applied to any subset of managed projects

### List Managed Projects

```bash
qq config → Projects & Templates → List all projects
```

Projects with missing directories are shown with a ❌ status.

## Template System

Templates are named `prepare-commit-msg` scripts stored in `~/.config/ai-commit/templates.json`. Each template tracks which projects it has been applied to.

### Default Template Script

```sh
#!/bin/sh
node .githooks/ai_commit.mjs "$1"
```

### Managing Templates

Access via `qq config → Projects & Templates → Templates`.

#### Create a New Template

1. Select **Create new template**
2. Enter a name
3. Edit the shell script (opens `$EDITOR`)
4. Save

The script must:
- Start with `#!/bin/sh`
- Contain `node .githooks/ai_commit.mjs "$1"` (or equivalent)

#### Apply a Template

1. Select a template → **Apply to projects**
2. Choose one or more managed projects from the checklist
3. The template is written to each project's `.githooks/prepare-commit-msg` and `core.hooksPath` is set

#### Update a Template

1. Select a template → **Edit script**
2. Modify the script in `$EDITOR`
3. On save, all projects previously linked to this template are updated automatically

#### Delete a Template

1. Select a template → **Delete template**
2. Confirm — projects are NOT affected, only the template definition is removed

## Use Cases

### Different Hooks per Project

```sh
# Template "strict-lint" applied to project A
#!/bin/sh
npm run lint || exit 1
node .githooks/ai_commit.mjs "$1"

# Template "default" applied to project B
#!/bin/sh
node .githooks/ai_commit.mjs "$1"
```

### Custom Pre-Hook Logic

```sh
#!/bin/sh
# Skip AI generation for merge commits
if [ "$2" = "merge" ]; then
  exit 0
fi
node .githooks/ai_commit.mjs "$1"
```

## Data Storage

All data lives under `~/.config/ai-commit/`:

| File | Format | Purpose |
|------|--------|---------|
| `managed-projects.json` | `{"projects": ["/path/to/repo", ...]}` | Registered repositories |
| `templates.json` | `{"name": {"script": "...", "appliedTo": ["/path", ...]}}` | Named hook templates |

## Uninstalling

```bash
qq uninstall
```

This:
1. Removes the current directory from managed projects
2. Deletes the `.githooks/` directory
3. Resets `git config core.hooksPath`
