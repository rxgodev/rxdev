import json
import os
import re
import subprocess
import sys
import traceback
import urllib.error
import urllib.request
from pathlib import Path

import pathspec

# === CONFIGURATION ===
CONFIG_DIR = Path.home() / ".config" / "ai-commit"
CONFIG_DIR.mkdir(parents=True, exist_ok=True)
CONFIG_FILE = CONFIG_DIR / "config.json"

API_URL = "https://apifreellm.com/api/chatAPI"
REQUEST_TIMEOUT = 30
MAX_ATTEMPTS = 3
MAX_DIFF_LENGTH = 3000


def load_user_config():
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Failed to load config: {e}", file=sys.stderr)
    return {"coauthor": True, "bumpVersion": False}


USER_CONFIG = load_user_config()
ADD_COAUTHOR = USER_CONFIG.get("coauthor", True)
BUMP_VERSION = USER_CONFIG.get("bumpVersion", False)


def is_valid_commit_message(msg: str) -> bool:
    if not msg.strip():
        return False

    lines = msg.strip().split("\n")
    subject = lines[0].strip()

    if re.search(r"[а-яА-ЯёЁ]", subject):
        return False

    match = re.match(r"^([a-z]+)(?:\([^)]*\))?:\s*(.+)$", subject)
    if not match:
        return False

    msg_type = match.group(1)
    description = match.group(2)

    valid_types = {
        "feat", "fix", "chore", "docs", "style", "refactor",
        "perf", "test", "build", "ci", "revert",
    }
    if msg_type not in valid_types:
        return False

    if len(subject) > 150:
        return False
    if description.endswith("."):
        return False

    return True


# === LOGGING ===
LOG_FILE = os.path.join(os.path.dirname(__file__), "..", "ai_commit_debug.log")


def log_message(message: str) -> None:
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"{message}\n")


SYSTEM_PROMPT = (
    "You are an expert Git commit message generator strictly following Conventional Commits 1.0.0.\n"
    "RULES:\n"
    "- SUBJECT: English, imperative mood, lowercase, max 50 chars. NO PERIOD at end.\n"
    "- TYPE: Use ONLY: feat, fix, chore, docs, style, refactor, perf, test, build, ci, revert.\n"
    "- SCOPE: Optional, in parentheses, e.g. (auth), (docs), (deps). Keep short.\n"
    "- BODY: In Russian. Explain WHY, not WHAT. Be specific: mention files, functions, or changes.\n"
    "- NEVER describe merge commits, version bumps, or generic 'update' without context.\n"
    "- NEVER invent details not present in the diff.\n"
    "- If changes are ONLY in README/docs use type 'docs'.\n"
    "- Output ONLY raw commit message. NO markdown, NO explanations, NO extra text.\n\n"
    "- Before you can updated code style by linters. DO NOT describe this in comment, ONLY IF this is only update\n\n"
    "BAD EXAMPLES (NEVER do this):\n"
    "  'update README.md' too vague\n"
    "  'Добавлено много документации' not specific\n"
    "  'Merge branch ...' ignore merge-related changes\n\n"
    "  'Изменён стиль: добавлены кавычки' изменение было не единственным, а комментарий описывает это\n\n"
    "GOOD EXAMPLES:\n"
    "docs(readme): add installation and release steps\n"
    "\n"
    "Расширена документация: добавлены шаги установки, развёртывания и релиза пакета. "
    "Обновлены разделы 'Технический стек', 'Фичи' и 'Переменные среды' в README.md.\n\n"
    "docs(package): describe flight map features and stack\n"
    "\n"
    "Добавлено описание пакета карты полётов: технический стек (Node.js 22, React 19), "
    "фичи (карта, взаимодействие с пилотом), и демо-ссылка."
)


def write_error_to_commit(msg_file, err_msg):
    with open(msg_file, "w", encoding="utf-8") as f:
        f.write("# AI COMMIT HOOK FAILED\n")
        f.write(f"# Reason: {err_msg}\n")


def read_commitignore(filepath=".commitignore") -> list:
    ignored = []
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    ignored.append(line)
    except FileNotFoundError:
        pass
    return ignored


def get_staged_diff():
    try:
        result = subprocess.run(
            ["git", "diff", "--cached", "--name-only"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
        )
        if result.returncode != 0:
            log_message(f"Failed to get staged files: {result.stderr}")
            return "", False

        staged_files = result.stdout.strip().splitlines()
        if not staged_files:
            return "", False

        exclude_patterns = read_commitignore()
        spec = pathspec.GitIgnoreSpec.from_lines(exclude_patterns)

        relevant_files = [f for f in staged_files if not spec.match_file(f)]

        log_message(f"Staged files: {staged_files}")
        log_message(f"Relevant files: {relevant_files}")

        if not relevant_files:
            log_message("No relevant staged files (all ignored by .commitignore).")
            return "", True

        result = subprocess.run(
            ["git", "diff", "--cached", "--no-color", "--unified=0"] + relevant_files,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
        )

        log_message(f"Raw diff length: {len(result.stdout)}")

        lines = result.stdout.splitlines()
        filtered = []
        current_file = None

        for line in lines:
            if line.startswith("diff --git"):
                parts = line.split()
                if len(parts) >= 3:
                    current_file = parts[-1].lstrip("b/")
                    if spec.match_file(current_file):
                        current_file = None
                        continue
                    filtered.append(f"\n# File: {current_file}")
            elif (
                current_file
                and line.startswith(("+", "-"))
                and not line.startswith(("+++", "---"))
            ):
                if len(line) > 1:
                    filtered.append(line)

        diff_text = "\n".join(filtered).strip()
        log_message(f"Filtered diff length: {len(diff_text)}")

        if not diff_text and relevant_files:
            log_message("No text diff (binary files or empty changes). Using file list.")
            file_list = "\n".join(f"  - {f}" for f in relevant_files)
            diff_text = f"Files changed (binary or no text diff):\n{file_list}"

        return diff_text, False

    except Exception as e:
        log_message(f"Error in get_staged_diff: {e}\n{traceback.format_exc()}")
        return "", False


def call_apifreellm(messages):
    payload = {"inputCode": messages}
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Origin": "https://apifreellm.com",
            "Referer": "https://apifreellm.com/",
            "User-Agent": "neuro-commit/3.0",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise Exception(f"HTTP {e.code}: {body}")
    except urllib.error.URLError as e:
        raise Exception(f"URL error: {e.reason}")

    text = raw.strip()

    if text.startswith("{"):
        try:
            data = json.loads(text)
            for key in ("response", "message", "content", "output", "result"):
                if isinstance(data.get(key), str):
                    text = data[key].strip()
                    break
        except json.JSONDecodeError:
            pass

    return text


def generate_commit_message(diff):
    user_prompt = f"Analyze this diff and create a commit message:\n\n---\n{diff}"
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]

    last_error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            log_message(f"Calling apifreellm.com (attempt {attempt}/{MAX_ATTEMPTS})")
            message = call_apifreellm(messages)

            if not message or message.startswith("#") or len(message) < 10:
                log_message(f"Response too short or invalid: {repr(message)}")
                last_error = "Empty or too-short response"
                continue

            if not is_valid_commit_message(message):
                log_message(f"Validation failed (attempt {attempt}): {repr(message[:120])}")
                last_error = "Response did not match Conventional Commits format"
                continue

            log_message(f"SUCCESS on attempt {attempt}")
            return message

        except Exception as e:
            last_error = str(e)
            log_message(f"FAILURE on attempt {attempt}: {e}")

    return f"ERROR: apifreellm.com failed after {MAX_ATTEMPTS} attempts ({last_error})"


# ============================================================
#  SMART CONVENTIONAL COMMITS PARSER
# ============================================================

def parse_commit(message: str) -> dict:
    lines = message.strip().split("\n")
    subject = lines[0].strip()

    match = re.match(
        r"^(?P<type>[a-z]+)"
        r"(?:\((?P<scope>[^)]*)\))?"
        r"(?P<breaking>!)?"
        r":\s*(?P<description>.+)$",
        subject,
    )

    result = {
        "type": None,
        "scope": None,
        "breaking": False,
        "description": None,
        "footer_breaking": False,
    }

    if match:
        result["type"] = match.group("type")
        result["scope"] = match.group("scope")
        result["breaking"] = match.group("breaking") == "!"
        result["description"] = match.group("description").strip()

    body = message[len(subject):].strip()
    if re.search(r"BREAKING[- ]CHANGE\s*:", body):
        result["footer_breaking"] = True

    return result


def determine_bump_kind(message: str) -> str:
    parsed = parse_commit(message)
    if parsed["breaking"] or parsed["footer_breaking"]:
        return "major"
    if parsed["type"] == "feat":
        return "minor"
    return "patch"


# ============================================================
#  PROPER SEMVER HANDLING
# ============================================================

SEMVER_RE = re.compile(
    r"^(?P<major>0|[1-9]\d*)"
    r"\.(?P<minor>0|[1-9]\d*)"
    r"\.(?P<patch>0|[1-9]\d*)"
    r"(?:-(?P<prerelease>[0-9a-zA-Z.-]+))?"
    r"(?:\+(?P<build>[0-9a-zA-Z.-]+))?$"
)


def parse_semver(version: str) -> dict | None:
    match = SEMVER_RE.match(version.strip())
    if not match:
        return None
    return {
        "major": int(match.group("major")),
        "minor": int(match.group("minor")),
        "patch": int(match.group("patch")),
        "prerelease": match.group("prerelease"),
        "build": match.group("build"),
    }


def bump_semver(version: str, kind: str) -> str | None:
    parsed = parse_semver(version)
    if not parsed:
        return None

    if kind == "major":
        parsed["major"] += 1
        parsed["minor"] = 0
        parsed["patch"] = 0
    elif kind == "minor":
        parsed["minor"] += 1
        parsed["patch"] = 0
    elif kind == "patch":
        parsed["patch"] += 1

    result = f"{parsed['major']}.{parsed['minor']}.{parsed['patch']}"
    if parsed["prerelease"]:
        result += f"-{parsed['prerelease']}"
    if parsed["build"]:
        result += f"+{parsed['build']}"

    return result


# ============================================================
#  MANIFEST HANDLERS — intelligent file-type support
# ============================================================

def _json_handle(content: str, new_version: str):
    try:
        data = json.loads(content)
        old = data.get("version")
        if old is None:
            return None, None
        if new_version == "__PEEK__":
            return None, old
        data["version"] = new_version
        return json.dumps(data, indent=2) + "\n", old
    except Exception:
        return None, None


def _toml_handle(content: str, new_version: str, sections: list[str]):
    old = _toml_extract(content, sections)
    if old is None:
        return None, None
    if new_version == "__PEEK__":
        return None, old
    return _toml_replace(content, sections, new_version, old)


def _toml_extract(content: str, sections: list[str]) -> str | None:
    try:
        import tomllib
        data = tomllib.loads(content)
    except (ImportError, Exception):
        return _toml_regex_extract(content, sections)

    for section_path in sections:
        keys = section_path.split(".")
        d = data
        try:
            for k in keys:
                d = d[k]
            if isinstance(d, dict):
                v = d.get("version")
                if v and isinstance(v, str):
                    return v
            elif isinstance(d, str):
                return d
        except (KeyError, TypeError):
            continue
    return None


def _toml_regex_extract(content: str, sections: list[str]) -> str | None:
    section_re = re.compile(r"^\s*\[([^\]]+)\]\s*$")
    ver_re = re.compile(r'^\s*version\s*=\s*"([^"]+)"')
    current_section = None
    for line in content.splitlines():
        sm = section_re.match(line)
        if sm:
            current_section = sm.group(1).strip()
            continue
        if current_section in sections:
            vm = ver_re.match(line)
            if vm:
                return vm.group(1)
    return None


def _toml_replace(content: str, sections: list[str], new_version: str, old: str) -> tuple[str | None, str | None]:
    section_re = re.compile(r"^\s*\[([^\]]+)\]\s*$")
    ver_re = re.compile(r'^(\s*version\s*=\s*")([^"]+)(".*)$')
    out_lines = []
    current_section = None
    replaced = False

    for line in content.splitlines(keepends=True):
        stripped = line.rstrip("\r\n")
        eol = line[len(stripped):]
        sm = section_re.match(stripped)
        if sm:
            current_section = sm.group(1).strip()
            out_lines.append(line)
            continue
        if not replaced and current_section in sections:
            vm = ver_re.match(stripped)
            if vm and vm.group(2) == old:
                out_lines.append(vm.group(1) + new_version + vm.group(3) + eol)
                replaced = True
                continue
        out_lines.append(line)

    if not replaced:
        return None, None
    return "".join(out_lines), old


def _yaml_handle(content: str, new_version: str):
    ver_re = re.compile(r'^(\s*version\s*:\s*["\']?)([^"\'\s#]+)(["\']?\s*)$', re.MULTILINE)
    match = ver_re.search(content)
    if not match:
        return None, None
    old = match.group(2)
    if new_version == "__PEEK__":
        return None, old
    new_content = content[:match.start(2)] + new_version + content[match.end(2):]
    return new_content, old


def _plain_handle(content: str, new_version: str):
    lines = content.strip().split("\n")
    if not lines:
        return None, None
    old = lines[0].strip()
    if not re.match(r"^\d+\.\d+\.\d+", old):
        return None, None
    if new_version == "__PEEK__":
        return None, old
    return new_version + "\n", old


def _gradle_handle(content: str, new_version: str):
    ver_re = re.compile(r"""^\s*version\s*=\s*["']([^"']+)["']\s*$""", re.MULTILINE)
    match = ver_re.search(content)
    if not match:
        return None, None
    old = match.group(1)
    if new_version == "__PEEK__":
        return None, old
    return content[:match.start(1)] + new_version + content[match.end(1):], old


def _csproj_handle(content: str, new_version: str):
    ver_re = re.compile(r"<Version>([^<]+)</Version>")
    match = ver_re.search(content)
    if not match:
        ver_re = re.compile(r"<PackageVersion>([^<]+)</PackageVersion>")
        match = ver_re.search(content)
    if not match:
        return None, None
    old = match.group(1)
    if new_version == "__PEEK__":
        return None, old
    return content[:match.start(1)] + new_version + content[match.end(1):], old


def _gemspec_handle(content: str, new_version: str):
    ver_re = re.compile(r"""\.version\s*=\s*["']([^"']+)["']""")
    match = ver_re.search(content)
    if not match:
        return None, None
    old = match.group(1)
    if new_version == "__PEEK__":
        return None, old
    return content[:match.start(1)] + new_version + content[match.end(1):], old


def _setupcfg_handle(content: str, new_version: str):
    ver_re = re.compile(r"^\s*version\s*=\s*(.+)$", re.MULTILINE)
    match = ver_re.search(content)
    if not match:
        return None, None
    old = match.group(1).strip()
    if new_version == "__PEEK__":
        return None, old
    return content[:match.start(1)] + new_version + content[match.end(1):], old


def _helm_handle(content: str, new_version: str):
    ver_re = re.compile(r'^(\s*version\s*:\s*["\']?)([^"\'\s#]+)(["\']?\s*)$', re.MULTILINE)
    app_re = re.compile(r'^(\s*appVersion\s*:\s*["\']?)([^"\'\s#]+)(["\']?\s*)$', re.MULTILINE)
    match = ver_re.search(content)
    if not match:
        return None, None
    old = match.group(2)
    if new_version == "__PEEK__":
        return None, old
    new_content = content[:match.start(2)] + new_version + content[match.end(2):]
    if app_re.search(new_content):
        new_content = re.sub(
            r'^(\s*appVersion\s*:\s*["\']?)([^"\'\s#]+)(["\']?\s*)$',
            lambda m: m.group(1) + new_version + (m.group(3) or ""),
            new_content,
            count=1,
            flags=re.MULTILINE,
        )
    return new_content, old


# ============================================================
#  MANIFEST REGISTRY — intelligent discovery
# ============================================================

class ManifestDef:
    def __init__(self, name: str, patterns: list[str], handler, **kwargs):
        self.name = name
        self.patterns = patterns
        self.handler = handler
        self.kwargs = kwargs

    def get_version(self, content: str) -> str | None:
        _, old = self.handler(content, "__PEEK__", **self.kwargs)
        return old

    def set_version(self, content: str, new_version: str):
        return self.handler(content, new_version, **self.kwargs)


MANIFEST_DEFINITIONS: list[ManifestDef] = [
    ManifestDef(
        "package.json",
        ["**/package.json"],
        _json_handle,
    ),
    ManifestDef(
        "composer.json",
        ["**/composer.json"],
        _json_handle,
    ),
    ManifestDef(
        "Cargo.toml",
        ["**/Cargo.toml"],
        _toml_handle,
        sections=["package"],
    ),
    ManifestDef(
        "pyproject.toml",
        ["**/pyproject.toml"],
        _toml_handle,
        sections=["project", "tool.poetry"],
    ),
    ManifestDef(
        "Chart.yaml",
        ["**/Chart.yaml"],
        _helm_handle,
    ),
    ManifestDef(
        "pubspec.yaml",
        ["**/pubspec.yaml"],
        _yaml_handle,
    ),
    ManifestDef(
        "build.gradle",
        ["**/build.gradle"],
        _gradle_handle,
    ),
    ManifestDef(
        "build.gradle.kts",
        ["**/build.gradle.kts"],
        _gradle_handle,
    ),
    ManifestDef(
        "Version.props",
        ["**/Version.props", "**/Directory.Build.props"],
        _csproj_handle,
    ),
    ManifestDef(
        "csproj",
        ["**/*.csproj"],
        _csproj_handle,
    ),
    ManifestDef(
        "gemspec",
        ["**/*.gemspec"],
        _gemspec_handle,
    ),
    ManifestDef(
        "setup.cfg",
        ["**/setup.cfg"],
        _setupcfg_handle,
    ),
    ManifestDef(
        "VERSION",
        ["**/VERSION"],
        _plain_handle,
    ),
    ManifestDef(
        "version.txt",
        ["**/version.txt"],
        _plain_handle,
    ),
    ManifestDef(
        ".bumpversion.cfg",
        ["**/.bumpversion.cfg"],
        _setupcfg_handle,
    ),
]


def discover_manifests(repo_root: Path) -> list[tuple[Path, ManifestDef]]:
    found: list[tuple[Path, ManifestDef]] = []
    seen = set()

    for mdef in MANIFEST_DEFINITIONS:
        for pattern in mdef.patterns:
            glob_part = pattern.replace("**/", "")
            matches = sorted(Path(repo_root).rglob(glob_part))
            for path in matches:
                if path.is_file():
                    normalized = str(path.resolve())
                    if normalized not in seen:
                        seen.add(normalized)
                        found.append((path, mdef))

    return found


# ============================================================
#  GIT TAG INTEGRATION
# ============================================================

def get_latest_tag_version(repo_root: Path) -> str | None:
    try:
        result = subprocess.run(
            ["git", "tag", "--sort=-version:refname"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
            cwd=repo_root,
        )
        if result.returncode != 0:
            return None
        tags = result.stdout.strip().splitlines()
        for tag in tags:
            tag = tag.strip().lstrip("v")
            if SEMVER_RE.match(tag):
                return tag
    except Exception as e:
        log_message(f"get_latest_tag_version failed: {e}")
    return None


# ============================================================
#  CHANGE-AWARE DIFF ANALYSIS
# ============================================================

def get_changed_files_in_scope(repo_root: Path, manifest_path: Path) -> set[str]:
    try:
        rel = manifest_path.relative_to(repo_root)
        prefix = os.path.dirname(str(rel).replace("\\", "/"))
        if prefix == ".":
            return set()

        result = subprocess.run(
            ["git", "diff", "--cached", "--name-only"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
            cwd=repo_root,
        )
        if result.returncode != 0:
            return set()

        changed = result.stdout.strip().splitlines()
        return {f for f in changed if f.startswith(prefix + "/") or (prefix == ".")}
    except Exception:
        return set()


def should_bump_manifest(manifest_path: Path, repo_root: Path, message: str) -> bool:
    parsed = parse_commit(message)
    if parsed["type"] in ("docs", "style", "test"):
        changed = get_changed_files_in_scope(repo_root, manifest_path)
        if not changed:
            return False
    return True


# ============================================================
#  Bump Helpers
# ============================================================

def find_repo_root():
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, encoding="utf-8", errors="ignore",
        )
        if result.returncode == 0:
            return Path(result.stdout.strip())
    except Exception as e:
        log_message(f"find_repo_root failed: {e}")
    return None


def staged_files() -> set:
    try:
        result = subprocess.run(
            ["git", "diff", "--cached", "--name-only"],
            capture_output=True, text=True, encoding="utf-8", errors="ignore",
        )
        if result.returncode != 0:
            return set()
        return set(result.stdout.split())
    except Exception:
        return set()


# ============================================================
#  MAIN BUMP ORCHESTRATOR
# ============================================================

def bump_project_version(kind: str, message: str = "") -> list[tuple]:
    repo_root = find_repo_root()
    if repo_root is None:
        return []

    already_staged = staged_files()
    manifests = discover_manifests(repo_root)

    if not manifests:
        log_message("bump: no manifests found in repo")
        return []

    bumps = []

    for path, mdef in manifests:
        rel_path = str(path.relative_to(repo_root)).replace("\\", "/")

        if rel_path in already_staged:
            log_message(f"bump: {rel_path} already staged, reading staged version")
            staged_content = subprocess.run(
                ["git", "show", f":{rel_path}"],
                capture_output=True, text=True, encoding="utf-8", errors="ignore",
                cwd=repo_root,
            ).stdout
            old_version = mdef.get_version(staged_content)
            if old_version is None:
                log_message(f"bump: cannot extract version from staged {rel_path}")
                continue
        else:
            try:
                content = path.read_text(encoding="utf-8")
            except Exception as e:
                log_message(f"bump: cannot read {rel_path}: {e}")
                continue

            old_version = mdef.get_version(content)
            if old_version is None:
                log_message(f"bump: no version field in {rel_path}")
                continue

        if not should_bump_manifest(path, repo_root, message):
            log_message(f"bump: skipping {rel_path} changes unrelated to this package")
            continue

        new_version = bump_semver(old_version, kind)
        if new_version is None:
            log_message(f"bump: cannot parse version '{old_version}' in {rel_path} as semver")
            continue

        if rel_path in already_staged:
            try:
                staged_content = subprocess.run(
                    ["git", "show", f":{rel_path}"],
                    capture_output=True, text=True, encoding="utf-8", errors="ignore",
                    cwd=repo_root,
                ).stdout
                new_content, _ = mdef.set_version(staged_content, new_version)
                if new_content is None:
                    continue
                path.write_text(new_content, encoding="utf-8")
            except Exception as e:
                log_message(f"bump: merge-safe write failed for {rel_path}: {e}")
                continue
        else:
            try:
                content = path.read_text(encoding="utf-8")
            except Exception as e:
                log_message(f"bump: cannot read {rel_path}: {e}")
                continue

            new_content, _ = mdef.set_version(content, new_version)
            if new_content is None:
                continue

            try:
                path.write_text(new_content, encoding="utf-8")
            except Exception as e:
                log_message(f"bump: cannot write {rel_path}: {e}")
                continue

        add = subprocess.run(
            ["git", "add", str(path)],
            capture_output=True, text=True, encoding="utf-8", errors="ignore",
            cwd=repo_root,
        )
        if add.returncode != 0:
            log_message(f"bump: git add {rel_path} failed: {add.stderr}")
            continue

        log_message(f"bump: {rel_path} {old_version} {new_version} ({kind})")
        bumps.append((rel_path, old_version, new_version))

    return bumps


# ============================================================
#  MAIN
# ============================================================

def main():
    log_message("\n--- HOOK STARTED ---")

    if len(sys.argv) < 2:
        commit_msg_file = ".git/COMMIT_EDITMSG"
        log_message("WARNING: No commit file provided, using default .git/COMMIT_EDITMSG")
    else:
        commit_msg_file = sys.argv[1]

    try:
        with open(commit_msg_file, "r", encoding="utf-8") as f:
            existing_content = f.read().strip()
    except Exception as e:
        existing_content = ""
        log_message(f"Could not read commit file: {e}")

    if existing_content and not existing_content.startswith("#"):
        log_message("User-provided commit message detected. Skipping AI generation.")
        sys.exit(0)

    print("[+] Auto Commit started")
    log_message(f"Commit file path: {commit_msg_file}")

    log_message("\nCHECKING FOR .husky")
    if ".husky" in os.listdir():
        reason = "Founded .husky directory in your project. Delete this!"
        write_error_to_commit(commit_msg_file, reason)
        sys.exit(0)

    diff, all_ignored = get_staged_diff()

    if not diff:
        if all_ignored:
            reason = "All staged files are ignored (listed in .commitignore)"
            write_error_to_commit(commit_msg_file, reason)
            log_message(f"INFO: {reason}")
        else:
            log_message("Exit: No staged changes found.")
        sys.exit(0)

    log_message(f"Diff found (length: {len(diff)}).")
    print("[+] Comment generation started")
    message = generate_commit_message(diff[:MAX_DIFF_LENGTH])

    if message and not message.startswith("ERROR:"):
        if BUMP_VERSION:
            kind = determine_bump_kind(message)
            bumps = bump_project_version(kind, message)
            if bumps:
                footer_lines = [
                    f"Bump version ({kind}):",
                    *(f"  {f}: {o} {n}" for f, o, n in bumps),
                ]
                for f, o, n in bumps:
                    print(f"[+] Bumped {f}: {o} {n} ({kind})")
                message += "\n\n" + "\n".join(footer_lines)
        if ADD_COAUTHOR:
            message += "\n\nCo-authored-by: autocommit-rxgo <autocommitrxgo@gmail.com>"
        with open(commit_msg_file, "w", encoding="utf-8") as f:
            f.write(message)
        log_message("Message written to commit file.")
    else:
        error_text = message.replace("ERROR: ", "", 1) if message else "Unknown error"
        write_error_to_commit(commit_msg_file, error_text)
        log_message(f"ERROR: {error_text}")

    log_message("--- HOOK FINISHED ---\n")


if __name__ == "__main__":
    if os.path.exists(LOG_FILE):
        os.remove(LOG_FILE)
    main()
