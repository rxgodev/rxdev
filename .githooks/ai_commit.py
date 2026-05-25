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
            print(f"⚠️ Failed to load config: {e}", file=sys.stderr)
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
    "- If changes are ONLY in README/docs — use type 'docs'.\n"
    "- Output ONLY raw commit message. NO markdown, NO explanations, NO extra text.\n\n"
    "- Before you can updated code style by linters. DO NOT describe this in comment, ONLY IF this is only update\n\n"
    "BAD EXAMPLES (NEVER do this):\n"
    "  'update README.md' → too vague\n"
    "  'Добавлено много документации' → not specific\n"
    "  'Merge branch ...' → ignore merge-related changes\n\n"
    "  'Изменён стиль: добавлены кавычки' → изменение было не единственным, а комментарий описывает это\n\n"
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
        f.write("# ❌ AI COMMIT HOOK FAILED\n")
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

    # If the server happens to return JSON instead of plain text, unwrap common fields.
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


# === VERSION BUMP ===

def determine_bump_kind(message: str) -> str:
    subject = message.strip().split("\n", 1)[0]
    match = re.match(r"^([a-z]+)(\([^)]*\))?(!)?:\s*", subject)
    if not match:
        return "patch"
    msg_type, _scope, breaking = match.groups()
    if breaking or "BREAKING CHANGE" in message:
        return "major"
    if msg_type == "feat":
        return "minor"
    return "patch"


def bump_semver(version: str, kind: str):
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)(.*)$", version.strip())
    if not match:
        return None
    major, minor, patch, suffix = match.groups()
    major, minor, patch = int(major), int(minor), int(patch)
    if kind == "major":
        return f"{major + 1}.0.0"
    if kind == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


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


def replace_package_json_version(content: str, new_version: str):
    match = re.search(r'^(\s*"version"\s*:\s*")([^"]+)(")', content, re.MULTILINE)
    if not match:
        return None, None
    old = match.group(2)
    return content[: match.start(2)] + new_version + content[match.end(2):], old


def replace_toml_version(content: str, sections: list, new_version: str):
    section_re = re.compile(r"^\s*\[([^\]]+)\]\s*$")
    ver_re = re.compile(r'^(\s*version\s*=\s*")([^"]+)(".*)$')
    out_lines = []
    current_section = None
    old = None
    for line in content.splitlines(keepends=True):
        stripped = line.rstrip("\r\n")
        eol = line[len(stripped):]
        sm = section_re.match(stripped)
        if sm:
            current_section = sm.group(1).strip()
            out_lines.append(line)
            continue
        if old is None and current_section in sections:
            vm = ver_re.match(stripped)
            if vm:
                old = vm.group(2)
                out_lines.append(vm.group(1) + new_version + vm.group(3) + eol)
                continue
        out_lines.append(line)
    if old is None:
        return None, None
    return "".join(out_lines), old


MANIFESTS = [
    ("package.json", lambda c, v: replace_package_json_version(c, v)),
    ("Cargo.toml", lambda c, v: replace_toml_version(c, ["package"], v)),
    ("pyproject.toml", lambda c, v: replace_toml_version(c, ["project", "tool.poetry"], v)),
]


def bump_project_version(kind: str):
    repo_root = find_repo_root()
    if repo_root is None:
        return []

    already_staged = staged_files()
    bumps = []

    for filename, replacer in MANIFESTS:
        path = repo_root / filename
        if not path.exists():
            continue
        if filename in already_staged:
            log_message(f"bump: {filename} already staged — assuming manual bump, skipping")
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except Exception as e:
            log_message(f"bump: cannot read {filename}: {e}")
            continue

        # Read current version to compute new value, then replace
        peek_old = None
        peek_new_content, peek_old = replacer(content, "__PLACEHOLDER__")
        if peek_old is None:
            log_message(f"bump: no version field in {filename}")
            continue

        new_version = bump_semver(peek_old, kind)
        if new_version is None:
            log_message(f"bump: cannot parse version '{peek_old}' in {filename} as semver")
            continue

        new_content, _ = replacer(content, new_version)
        if new_content is None:
            continue

        try:
            path.write_text(new_content, encoding="utf-8")
        except Exception as e:
            log_message(f"bump: cannot write {filename}: {e}")
            continue

        add = subprocess.run(
            ["git", "add", str(path)],
            capture_output=True, text=True, encoding="utf-8", errors="ignore",
        )
        if add.returncode != 0:
            log_message(f"bump: git add {filename} failed: {add.stderr}")
            continue

        log_message(f"bump: {filename} {peek_old} → {new_version} ({kind})")
        bumps.append((filename, peek_old, new_version))

    return bumps


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
            bumps = bump_project_version(kind)
            if bumps:
                footer_lines = [
                    f"Bump version ({kind}):",
                    *(f"  {f}: {o} → {n}" for f, o, n in bumps),
                ]
                for f, o, n in bumps:
                    print(f"[+] Bumped {f}: {o} → {n} ({kind})")
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
