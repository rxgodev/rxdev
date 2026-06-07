from __future__ import annotations

NEURO_COMMIT_VERSION = "2.19.3"
import json
import os
import re
import subprocess
import sys
import textwrap
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

import pathspec

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

# === CONFIGURATION ===
CONFIG_DIR = Path.home() / ".config" / "ai-commit"
CONFIG_DIR.mkdir(parents=True, exist_ok=True)
CONFIG_FILE = CONFIG_DIR / "config.json"

# OpenAI-compatible providers. All four speak the same chat-completions API,
# so switching is just base URL + auth + model. Ollama runs locally (no key,
# diffs never leave the machine).
PROVIDERS = {
    "groq": {
        "url": "https://api.groq.com/openai/v1/chat/completions",
        "env": "GROQ_API_KEY",
        "default_model": "llama-3.1-8b-instant",
        "needs_key": True,
    },
    "openai": {
        "url": "https://api.openai.com/v1/chat/completions",
        "env": "OPENAI_API_KEY",
        "default_model": "gpt-4o-mini",
        "needs_key": True,
    },
    "openrouter": {
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "env": "OPENROUTER_API_KEY",
        "default_model": "openai/gpt-4o-mini",
        "needs_key": True,
    },
    "ollama": {
        "url": "http://localhost:11434/v1/chat/completions",
        "env": "OLLAMA_API_KEY",
        "default_model": "llama3.1",
        "needs_key": False,
    },
}
DEFAULT_PROVIDER = "groq"

REQUEST_TIMEOUT = 60
MAX_ATTEMPTS = 3
MAX_DIFF_LENGTH = 3000

DEFAULT_GROQ_MODEL = "llama-3.1-8b-instant"
DEFAULT_VALID_TYPES = {
    "feat", "fix", "chore", "docs", "style",
    "refactor", "perf", "test", "build", "ci", "revert",
}

BODY_LANGUAGE_PROMPTS = {
    "en": "Body: one short WHY sentence in past tense. NO lists, NO file names, NO bullet points.",
    "ru": "Body: ОДНО короткое предложение WHY в прошлом времени. БЕЗ списков, БЕЗ имён файлов.",
    "de": "Body: EIN kurzer WHY-Satz im Präteritum. KEINE Listen, KEINE Dateinamen, KEINE Aufzählungen.",
    "fr": "Body: UNE courte phrase WHY au passé. PAS de listes, PAS de noms de fichiers, PAS de puces.",
    "zh": "Body: 一个短句WHY，过去时。不要列表，不要文件名，不要项目符号。",
}

BODY_EXAMPLES = {
    "en": "EXAMPLES:\n  docs(readme): add install steps\n\n  Needed to help new contributors get started.\n  feat(api): implement OAuth2\n\n  Required secure token-based API auth.\n  fix(auth): handle timeout\n\n  Login was hanging indefinitely on slow connections.",
    "ru": "EXAMPLES:\n  docs(readme): add install steps\n\n  Понадобилось для онбординга новичков.\n  feat(api): implement OAuth2\n\n  Потребовалась безопасная аутентификация для API.\n  fix(auth): handle timeout\n\n  Логин зависал при медленном соединении.",
    "de": "EXAMPLES:\n  docs(readme): add install steps\n\n  Für das Onboarding neuer Mitwirkender nötig.\n  feat(api): implement OAuth2\n\n  Sichere Token-Authentifizierung für die API erforderlich.\n  fix(auth): handle timeout\n\n  Login hängte sich bei langsamen Verbindungen auf.",
    "fr": "EXAMPLES:\n  docs(readme): add install steps\n\n  Nécessaire pour l'intégration des nouveaux contributeurs.\n  feat(api): implement OAuth2\n\n  Authentification API sécurisée par token requise.\n  fix(auth): handle timeout\n\n  La connexion bloquait indéfiniment sur les connexions lentes.",
    "zh": "EXAMPLES:\n  docs(readme): add install steps\n\n  需要为新贡献者提供入门帮助。\n  feat(api): implement OAuth2\n\n  需要安全的基于令牌的 API 认证。\n  fix(auth): handle timeout\n\n  登录在慢连接上无限挂起。",
}

BAD_EXAMPLES = (
    "CRITICAL rules:\n"
    "- description starts with a lowercase letter (Add -> add, Fix -> fix)\n"
    "- body is ONE short WHY sentence. NO lists, NO file names, NO line items\n"
    "- feat = new feature for user, fix = bug fix, docs = docs only, refactor = code change with no behavior change\n"
    "- Output ONLY the commit. No commentary."
)

SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".venv", "venv", ".tox", ".eggs", "dist", "build", ".git2", ".svn"}


def _is_skipped_dir(path: Path) -> bool:
    for part in path.parts:
        if part in SKIP_DIRS:
            return True
    return False


def _build_type_regex(types_set: set[str]) -> str:
    sorted_types = sorted(types_set, key=len, reverse=True)
    return "|".join(re.escape(t) for t in sorted_types)


valid_types_global: set[str] = set()


def build_system_prompt(types_str: str, language: str, custom_prompt: str = "") -> str:
    if custom_prompt:
        return custom_prompt.replace("{types}", types_str)

    body_prompt = BODY_LANGUAGE_PROMPTS.get(language, BODY_LANGUAGE_PROMPTS["ru"])
    good_examples = BODY_EXAMPLES.get(language, BODY_EXAMPLES["ru"])

    return (
        "Format:\ntype(scope): lowercase description\n\none short WHY sentence\n"
        f"Valid types: {types_str}.\n"
        f"- {body_prompt}\n"
        f"{BAD_EXAMPLES}\n"
        f"{good_examples}"
    )


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

PROVIDER = (USER_CONFIG.get("provider") or DEFAULT_PROVIDER).lower()
PROVIDER_DEF = PROVIDERS.get(PROVIDER) or {
    "url": PROVIDERS[DEFAULT_PROVIDER]["url"],
    "env": "NEURO_COMMIT_API_KEY",
    "default_model": DEFAULT_GROQ_MODEL,
    "needs_key": False,  # custom/unknown provider: don't block, let the endpoint decide
}
API_URL = USER_CONFIG.get("apiUrl") or PROVIDER_DEF["url"]
API_KEY = (
    USER_CONFIG.get("apiKey")
    or os.environ.get(PROVIDER_DEF["env"], "")
    or os.environ.get("NEURO_COMMIT_API_KEY", "")
)
PROVIDER_NEEDS_KEY = PROVIDER_DEF["needs_key"]
GROQ_MODEL = USER_CONFIG.get("model") or PROVIDER_DEF["default_model"]
CUSTOM_TYPES = set(USER_CONFIG.get("customTypes", []))
CUSTOM_PROMPT = USER_CONFIG.get("prompt", "")
LANGUAGE = USER_CONFIG.get("language", "ru")

valid_types_global = DEFAULT_VALID_TYPES | CUSTOM_TYPES
types_str = ", ".join(sorted(valid_types_global))
TYPE_REGEX_STR = _build_type_regex(valid_types_global)
TYPE_REGEX = re.compile(rf"^(?:{TYPE_REGEX_STR})", re.IGNORECASE)

SYSTEM_PROMPT = build_system_prompt(types_str, LANGUAGE, CUSTOM_PROMPT)


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

    if msg_type not in valid_types_global:
        return False

    if len(subject) > 150:
        return False
    if description.endswith("."):
        return False

    return True


# === LOGGING ===
LOG_FILE = os.path.join(os.path.dirname(__file__), "..", "ai_commit_debug.log")
MAX_LOG_BYTES = 512 * 1024  # keep one previous run for debugging, but bound growth


def log_message(message: str) -> None:
    try:
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > MAX_LOG_BYTES:
            try:
                os.replace(LOG_FILE, LOG_FILE + ".1")
            except OSError:
                pass
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"{message}\n")
    except OSError:
        # logging must never break the commit flow
        pass


def write_error_to_commit(msg_file, err_msg):
    with open(msg_file, "w", encoding="utf-8") as f:
        f.write(f"# NeuroCommit: {err_msg}\n")


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
                    current_file = parts[-1]
                    if current_file.startswith("b/"):
                        current_file = current_file[2:]
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
            log_message(
                "No text diff (binary files or empty changes). Using file list."
            )
            file_list = "\n".join(f"  - {f}" for f in relevant_files)
            diff_text = f"Files changed (binary or no text diff):\n{file_list}"

        return diff_text, False

    except Exception as e:
        log_message(f"Error in get_staged_diff: {e}\n{traceback.format_exc()}")
        return "", False


def call_llm(messages, echo=True, clean=True, temperature=0.0, max_tokens=None):
    """Call the configured OpenAI-compatible provider.

    echo:  stream tokens to stdout live (commit flow). Off for subcommands
           whose stdout is captured/parsed by the CLI.
    clean: run the commit-message cleaner on the result. Off for raw output
           (PR bodies, JSON split plans).
    """
    if PROVIDER_NEEDS_KEY and not API_KEY:
        raise Exception(
            f"API key for provider '{PROVIDER}' is not set. Run 'qq config' to set "
            f"your key, export {PROVIDER_DEF['env']}, or switch provider "
            "(e.g. 'ollama' runs locally with no key)."
        )

    payload = {
        "model": GROQ_MODEL,
        "messages": messages,
        "stream": True,
        "temperature": temperature,
    }
    if max_tokens:
        payload["max_tokens"] = max_tokens
    headers = {
        "Content-Type": "application/json",
        "User-Agent": f"neuro-commit/{NEURO_COMMIT_VERSION}",
    }
    if API_KEY:
        headers["Authorization"] = f"Bearer {API_KEY}"

    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as response:
            response_text = ""
            for line_bytes in response:
                line = line_bytes.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                if line.startswith("data: "):
                    data_str = line[6:]
                    if data_str == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data_str)
                        delta = chunk["choices"][0]["delta"]
                        if "content" in delta:
                            content = delta["content"]
                            response_text += content
                            if echo:
                                sys.stdout.buffer.write(content.encode("utf-8"))
                                sys.stdout.buffer.flush()
                    except (json.JSONDecodeError, KeyError, IndexError):
                        pass
            if echo:
                print(flush=True)
            text = response_text.strip()
            return _clean_llm_response(text) if clean else text
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        if e.code == 429:
            log_message(f"{PROVIDER} rate limited: {body}")
            raise Exception(f"{PROVIDER} API rate limit exceeded. Wait a moment and retry.")
        raise Exception(f"{PROVIDER} API HTTP {e.code}: {body}")
    except urllib.error.URLError as e:
        raise Exception(
            f"{PROVIDER} API URL error: {e.reason} "
            f"(is the endpoint {API_URL} reachable?)"
        )


def _normalize_type(text: str) -> str:
    m = re.match(r"^(" + TYPE_REGEX_STR + r")", text, re.IGNORECASE)
    if m:
        rest = text[m.end():].lstrip(": ").strip()
        scope_match = re.match(r"^\(([^)]*)\)\s*:\s*(.*)", rest)
        if scope_match:
            return m.group(1).lower() + f"({scope_match.group(1)}): " + scope_match.group(2).strip()
        return m.group(1).lower() + ": " + rest
    return text


def _clean_llm_response(text: str) -> str:
    text = re.sub(r"\*{1,2}", "", text)
    text = re.sub(r"`{1,3}", "", text)

    lines = text.strip().split("\n")
    skip_prefixes = (
        "commit message", "response", "output", "result",
        "explanation", "changes", "summary", "diff", "analysis",
        "here is", "here's", "based on", "it appears", "a suitable",
        "the diff shows", "looking at", "in this commit",
    )
    stop_prefixes = (
        "however", "alternatively", "if you want", "it's worth noting",
        "the feat", "the fix", "the chore", "the docs", "the style",
        "the refactor", "the test", "the build", "the ci", "the revert",
        "or, if you", "or you could", "note:", "note that",
        "this commit message", "this commit follows",
        "in this case", "the conventional",
        "by the way", "as an alternative",
        "the diff shows", "type(scope)", "type(scope):",
    )
    _commit_re = re.compile(
        rf"^(?:{TYPE_REGEX_STR})(?:\([^)]*\))?\s*:", re.IGNORECASE
    )

    start = 0
    for i, line in enumerate(lines):
        lowered = line.strip().lower()
        if any(lowered.startswith(p) for p in skip_prefixes):
            start = i + 1
        elif not line.strip():
            continue
        else:
            break

    body_lines = lines[start:]
    subject = None
    body_parts = []
    found_subject = False

    for line in body_lines:
        stripped = line.strip()
        lowered = stripped.lower()

        if not found_subject:
            if not stripped:
                continue
            if _commit_re.match(stripped) or TYPE_REGEX.match(stripped):
                subject = stripped
                found_subject = True
            continue

        if not stripped:
            body_parts.append("")
            continue

        if any(lowered.startswith(p) for p in stop_prefixes):
            break

        if _commit_re.match(stripped):
            break

        body_parts.append(stripped)

    if not subject:
        return "chore: update files"

    subject = _normalize_type(subject).rstrip(".")
    if len(subject) > 150:
        subject = subject[:147] + "..."

    body = "\n".join(body_parts).strip()
    if body:
        return f"{subject}\n\n{body}"

    return subject


def generate_commit_message(diff):
    user_prompt = f"write a commit (subject + blank line + body explaining why) for:\n\n---\n{diff}\n---"
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]

    last_error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            log_message(f"Calling Groq (attempt {attempt}/{MAX_ATTEMPTS})")
            print(f"[{attempt}/{MAX_ATTEMPTS}] Generating commit message...\n", flush=True)
            message = call_llm(messages)

            if not message or message.startswith("#") or len(message) < 10:
                log_message(f"Response too short or invalid: {repr(message)}")
                last_error = "Empty or too-short response"
                continue

            if not is_valid_commit_message(message):
                log_message(
                    f"Validation failed (attempt {attempt}): {repr(message[:120])}"
                )
                last_error = "Response did not match Conventional Commits format"
                continue

            log_message(f"SUCCESS on attempt {attempt}")
            return message

        except Exception as e:
            last_error = str(e)
            log_message(f"FAILURE on attempt {attempt}: {e}")
            if attempt < MAX_ATTEMPTS:
                print(f"  Retry: {e}")

    log_message(f"All {MAX_ATTEMPTS} attempts failed, using fallback generator")
    return None


# ============================================================
#  FALLBACK COMMIT GENERATOR
# ============================================================


def generate_fallback_message(diff: str) -> str:
    parsed_type = "chore"
    parsed_scope = None
    files = []
    seen_scopes = set()

    for line in diff.splitlines():
        m = re.match(r"^# File: (.+)$", line)
        if m:
            path = m.group(1)
            files.append(path)
            ext = os.path.splitext(path)[1].lower()
            ext_types = {
                ".py": "feat"
                if any(kw in path.lower() for kw in ["feat", "add", "impl", "new"])
                else "refactor",
                ".js": "feat",
                ".ts": "feat",
                ".jsx": "feat",
                ".tsx": "feat",
                ".json": "config",
                ".toml": "config",
                ".yaml": "config",
                ".yml": "config",
                ".md": "docs",
                ".css": "style",
                ".scss": "style",
                ".html": "feat",
            }
            for pattern, ptype in ext_types.items():
                if path.lower().endswith(pattern):
                    if ptype not in ("config",) and (
                        ptype != "docs" or parsed_type == "chore"
                    ):
                        parsed_type = ptype
                    break

            if path.endswith(".test.js") or path.endswith(".test.ts") or path.endswith(".test.jsx") or path.endswith(".test.tsx") or path.endswith("_test.py") or path.endswith(".spec.js") or path.endswith(".spec.ts"):
                parsed_type = "test"

            dirs = path.split("/")
            for d in dirs[:-1]:
                if d not in (
                    "src",
                    "lib",
                    "app",
                    "tests",
                    ".githooks",
                ) and not d.startswith("."):
                    seen_scopes.add(d)

    if seen_scopes:
        sorted_scopes = sorted(
            seen_scopes, key=lambda s: -sum(1 for f in files if s in f)
        )
        parsed_scope = sorted_scopes[0]

    type_map = {
        "feat": "feat",
        "fix": "fix",
        "docs": "docs",
        "style": "style",
        "refactor": "refactor",
        "test": "test",
        "config": "chore",
    }
    commit_type = type_map.get(parsed_type, "chore")

    short_files = [f.split("/")[-1] for f in files[:5]]
    desc = ", ".join(short_files)
    if len(files) > 5:
        desc += f" and {len(files) - 5} more"

    scope = f"({parsed_scope})" if parsed_scope else ""
    subject = f"{commit_type}{scope}: update {desc}"

    body_parts = []
    dir_changes = {}
    for f in files:
        dir_name = os.path.dirname(f) or "."
        dir_changes.setdefault(dir_name, []).append(f.split("/")[-1])

    for directory, filenames in sorted(dir_changes.items()):
        file_list = ", ".join(filenames[:3])
        if len(filenames) > 3:
            file_list += f" and {len(filenames) - 3} more"
        body_parts.append(f"- {directory}: {file_list}")

    body = "\n".join(body_parts)

    return f"{subject}\n\n{body}"


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

    body = message[len(subject) :].strip()
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


def _toml_replace(
    content: str, sections: list[str], new_version: str, old: str
) -> tuple[str | None, str | None]:
    section_re = re.compile(r"^\s*\[([^\]]+)\]\s*$")
    ver_re = re.compile(r'^(\s*version\s*=\s*")([^"]+)(".*)$')
    out_lines = []
    current_section = None
    replaced = False

    for line in content.splitlines(keepends=True):
        stripped = line.rstrip("\r\n")
        eol = line[len(stripped) :]
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
    ver_re = re.compile(
        r"^version\s*:\s*['\"]?([^'\s#]\S*)['\"]?\s*$", re.MULTILINE
    )
    match = ver_re.search(content)
    if not match:
        return None, None
    old = match.group(1)
    if new_version == "__PEEK__":
        return None, old

    start, end = match.start(1), match.end(1)
    new_content = content[:start] + new_version + content[end:]
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
    return content[: match.start(1)] + new_version + content[match.end(1) :], old


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
    return content[: match.start(1)] + new_version + content[match.end(1) :], old


def _gemspec_handle(content: str, new_version: str):
    ver_re = re.compile(r"""\.version\s*=\s*["']([^"']+)["']""")
    match = ver_re.search(content)
    if not match:
        return None, None
    old = match.group(1)
    if new_version == "__PEEK__":
        return None, old
    return content[: match.start(1)] + new_version + content[match.end(1) :], old


def _setupcfg_handle(content: str, new_version: str):
    ver_re = re.compile(r"^\s*version\s*=\s*(.+)$", re.MULTILINE)
    match = ver_re.search(content)
    if not match:
        return None, None
    old = match.group(1).strip()
    if new_version == "__PEEK__":
        return None, old
    return content[: match.start(1)] + new_version + content[match.end(1) :], old


def _helm_handle(content: str, new_version: str):
    ver_re = re.compile(
        r'^(\s*version\s*:\s*["\']?)([^"\'\s#]+)(["\']?\s*)$', re.MULTILINE
    )
    app_re = re.compile(
        r'^(\s*appVersion\s*:\s*["\']?)([^"\'\s#]+)(["\']?\s*)$', re.MULTILINE
    )
    match = ver_re.search(content)
    if not match:
        return None, None
    old = match.group(2)
    if new_version == "__PEEK__":
        return None, old
    new_content = content[: match.start(2)] + new_version + content[match.end(2) :]
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
    ManifestDef("package.json", ["**/package.json"], _json_handle),
    ManifestDef("composer.json", ["**/composer.json"], _json_handle),
    ManifestDef("Cargo.toml", ["**/Cargo.toml"], _toml_handle, sections=["package"]),
    ManifestDef("pyproject.toml", ["**/pyproject.toml"], _toml_handle, sections=["project", "tool.poetry"]),
    ManifestDef("Chart.yaml", ["**/Chart.yaml"], _helm_handle),
    ManifestDef("pubspec.yaml", ["**/pubspec.yaml"], _yaml_handle),
    ManifestDef("build.gradle", ["**/build.gradle"], _gradle_handle),
    ManifestDef("build.gradle.kts", ["**/build.gradle.kts"], _gradle_handle),
    ManifestDef("Version.props", ["**/Version.props", "**/Directory.Build.props"], _csproj_handle),
    ManifestDef("csproj", ["**/*.csproj"], _csproj_handle),
    ManifestDef("gemspec", ["**/*.gemspec"], _gemspec_handle),
    ManifestDef("setup.cfg", ["**/setup.cfg"], _setupcfg_handle),
    ManifestDef("VERSION", ["**/VERSION"], _plain_handle),
    ManifestDef("version.txt", ["**/version.txt"], _plain_handle),
    ManifestDef(".bumpversion.cfg", ["**/.bumpversion.cfg"], _setupcfg_handle),
]


def discover_manifests(repo_root: Path) -> list[tuple[Path, ManifestDef]]:
    found: list[tuple[Path, ManifestDef]] = []
    seen = set()

    for mdef in MANIFEST_DEFINITIONS:
        for pattern in mdef.patterns:
            glob_part = pattern.replace("**/", "")
            matches = sorted(Path(repo_root).rglob(glob_part))
            for path in matches:
                if not path.is_file():
                    continue
                if _is_skipped_dir(path):
                    continue
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
        prefix_slash = prefix + "/"
        return {f for f in changed if f.startswith(prefix_slash)}
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
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
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
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
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

    manifests = discover_manifests(repo_root)

    if not manifests:
        log_message("bump: no manifests found in repo")
        return []

    bumps = []
    originals: list[tuple[Path, str]] = []

    for path, mdef in manifests:
        rel_path = str(path.relative_to(repo_root)).replace("\\", "/")

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
            log_message(
                f"bump: cannot parse version '{old_version}' in {rel_path} as semver"
            )
            continue

        new_content, _ = mdef.set_version(content, new_version)
        if new_content is None:
            continue

        originals.append((path, content))

        try:
            path.write_text(new_content, encoding="utf-8")
        except Exception as e:
            log_message(f"bump: cannot write {rel_path}: {e}")
            continue

        log_message(f"bump: {rel_path} {old_version} {new_version} ({kind})")
        bumps.append((rel_path, old_version, new_version))

    return bumps


def _amend_bump(bumps: list[tuple], repo_root: Path, old_head: str = "") -> None:
    if not bumps or os.environ.get("NEURO_COMMIT_AMENDING") == "1":
        return

    import json
    import subprocess
    import sys
    import time

    log_path = repo_root / "ai_commit_debug.log"
    log_path_str = str(log_path).replace("\\", "\\\\")

    amend_script = textwrap.dedent(f"""\
        import subprocess, os, time, sys

        repo_root = {str(repo_root)!r}
        bumps = {json.dumps(bumps)}
        old_head = {old_head!r}

        if not old_head:
            old_head = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True, text=True, encoding="utf-8", errors="ignore",
                cwd=repo_root,
            ).stdout.strip()

        committed = False
        for _ in range(600):
            time.sleep(0.1)
            new_head = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True, text=True, encoding="utf-8", errors="ignore",
                cwd=repo_root,
            ).stdout.strip()
            if new_head and new_head != old_head:
                committed = True
                break

        if not committed:
            with open("{log_path_str}", "a", encoding="utf-8") as f:
                f.write("amend: no new commit detected within timeout; skipping version-bump amend\\n")
            sys.exit(0)

        for rel_path, _, new_version in bumps:
            path = os.path.join(repo_root, rel_path)
            subprocess.run(
                ["git", "add", str(path)],
                capture_output=True, text=True, encoding="utf-8", errors="ignore",
                cwd=repo_root,
            )

        env = {{**os.environ, "GIT_EDITOR": "true", "NEURO_COMMIT_AMENDING": "1"}}
        amend = subprocess.run(
            ["git", "commit", "--amend", "--no-edit"],
            capture_output=True, text=True, encoding="utf-8", errors="ignore",
            cwd=repo_root,
            env=env,
        )
        if amend.returncode == 0:
            with open("{log_path_str}", "a", encoding="utf-8") as f:
                f.write("amend: commit amended with bumped version\\n")
    """)

    subprocess.Popen(
        [sys.executable, "-c", amend_script],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        cwd=repo_root,
    )


# ============================================================
#  CONFLICT DETECTION — detect other hook managers
# ============================================================


def check_conflicting_hooks(repo_root: str) -> str | None:
    conflicts = []

    husky_dir = os.path.join(repo_root, ".husky")
    if os.path.isdir(husky_dir):
        conflicts.append(".husky directory detected — conflicts with NeuroCommit hooks. Delete it or run `npx husky uninstall`.")

    lefthook = os.path.join(repo_root, "lefthook.yml")
    lefthook_alt = os.path.join(repo_root, "lefthook.yaml")
    if os.path.isfile(lefthook) or os.path.isfile(lefthook_alt):
        conflicts.append("lefthook config detected — may conflict with NeuroCommit hooks.")

    precommit = os.path.join(repo_root, ".pre-commit-config.yaml")
    if os.path.isfile(precommit):
        conflicts.append(".pre-commit-config.yaml detected — may conflict with core.hooksPath.")

    return "\n".join(conflicts) if conflicts else None


# ============================================================
#  CLI SUBCOMMANDS — scan / release / pr / split
#  (invoked by the Node CLI; each prints a single JSON object/array)
# ============================================================


def _git(args, cwd=None):
    try:
        r = subprocess.run(
            ["git", *args],
            capture_output=True, text=True, encoding="utf-8", errors="ignore",
            cwd=cwd,
        )
        return r.stdout if r.returncode == 0 else ""
    except Exception:
        return ""


def _extract_json(text):
    """Best-effort parse of a JSON object/array possibly wrapped in prose/fences."""
    if not text:
        return None
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t).strip()
    try:
        return json.loads(t)
    except Exception:
        pass
    for opener, closer in (("[", "]"), ("{", "}")):
        i, j = t.find(opener), t.rfind(closer)
        if i != -1 and j > i:
            try:
                return json.loads(t[i:j + 1])
            except Exception:
                continue
    return None


def detect_default_branch():
    ref = _git(["symbolic-ref", "refs/remotes/origin/HEAD"]).strip()
    if ref:
        return ref.rsplit("/", 1)[-1]
    for b in ("main", "master"):
        if _git(["rev-parse", "--verify", "--quiet", b]).strip():
            return b
    return "main"


# --- secret scanning (deterministic; secrets must never be sent to an LLM) ---

SECRET_PATTERNS = [
    ("AWS access key id", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("AWS secret access key", re.compile(r"(?i)aws_secret_access_key\s*[=:]\s*['\"]?[A-Za-z0-9/+=]{40}")),
    ("GitHub token", re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}")),
    ("GitHub fine-grained PAT", re.compile(r"github_pat_[A-Za-z0-9_]{60,}")),
    ("Google API key", re.compile(r"AIza[0-9A-Za-z\-_]{35}")),
    ("Slack token", re.compile(r"xox[baprs]-[0-9A-Za-z-]{10,}")),
    ("Stripe secret key", re.compile(r"sk_live_[0-9A-Za-z]{24,}")),
    ("Private key block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----")),
    ("JSON Web Token", re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")),
    ("Hardcoded secret assignment", re.compile(r"(?i)(api[_-]?key|secret|token|passwd|password)\s*[=:]\s*['\"][^'\"]{8,}['\"]")),
]


def scan_diff_for_secrets(diff_text: str):
    findings = []
    current_file = None
    for line in diff_text.splitlines():
        if line.startswith("diff --git"):
            parts = line.split()
            if parts:
                current_file = parts[-1]
                if current_file.startswith("b/"):
                    current_file = current_file[2:]
        elif line.startswith("+") and not line.startswith("+++"):
            added = line[1:]
            for name, pat in SECRET_PATTERNS:
                m = pat.search(added)
                if m:
                    s = m.group(0)
                    masked = (s[:4] + "…" + s[-4:]) if len(s) > 12 else "…"
                    findings.append({"file": current_file, "type": name, "preview": masked})
                    break
    return findings


def scan_staged_secrets():
    return scan_diff_for_secrets(_git(["diff", "--cached", "--no-color", "--unified=0"]))


# --- changelog / release ---

SECTION_ORDER = [
    ("feat", "Features"),
    ("fix", "Bug Fixes"),
    ("perf", "Performance"),
    ("refactor", "Refactoring"),
    ("docs", "Documentation"),
    ("revert", "Reverts"),
]
SECTION_KEYS = {k for k, _ in SECTION_ORDER}


def _collect_commits(rev_range: str):
    out = _git(["log", rev_range, "--no-merges", "--pretty=format:%h%x1f%s%x1f%b%x1e"])
    commits = []
    for rec in out.split("\x1e"):
        rec = rec.strip("\n")
        if not rec.strip():
            continue
        fields = rec.split("\x1f")
        if len(fields) < 2:
            continue
        commits.append({
            "hash": fields[0].strip(),
            "subject": fields[1].strip(),
            "body": (fields[2] if len(fields) > 2 else "").strip(),
        })
    return commits


def _group_commits(commits):
    groups = {}
    breaking = []
    rank = {"patch": 1, "minor": 2, "major": 3}
    bump = "patch"
    for c in commits:
        parsed = parse_commit(c["subject"])
        full = c["subject"] + ("\n\n" + c["body"] if c["body"] else "")
        kind = determine_bump_kind(full)
        if rank[kind] > rank[bump]:
            bump = kind
        if parsed["breaking"] or parsed["footer_breaking"]:
            breaking.append(f"{parsed['description'] or c['subject']} ({c['hash']})")
        t = parsed["type"]
        if t in SECTION_KEYS and parsed["description"]:
            groups.setdefault(t, []).append({
                "scope": parsed["scope"],
                "desc": parsed["description"],
                "hash": c["hash"],
            })
    return groups, breaking, bump


def _render_changelog(version: str, groups, breaking, date_str: str) -> str:
    lines = [f"## [{version}] - {date_str}", ""]
    if breaking:
        lines.append("### ⚠ BREAKING CHANGES")
        lines.extend(f"- {b}" for b in breaking)
        lines.append("")
    for key, title in SECTION_ORDER:
        items = groups.get(key)
        if not items:
            continue
        lines.append(f"### {title}")
        for it in items:
            scope = f"**{it['scope']}:** " if it["scope"] else ""
            lines.append(f"- {scope}{it['desc']} ({it['hash']})")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _semver_max(a, b):
    if not a:
        return b
    if not b:
        return a
    pa, pb = parse_semver(a), parse_semver(b)
    if not pa:
        return b
    if not pb:
        return a
    ta = (pa["major"], pa["minor"], pa["patch"])
    tb = (pb["major"], pb["minor"], pb["patch"])
    return a if ta >= tb else b


def build_release_info():
    import datetime

    repo_root = find_repo_root() or Path.cwd()
    last_tag = _git(["describe", "--tags", "--abbrev=0"]).strip()
    rev_range = f"{last_tag}..HEAD" if last_tag else "HEAD"
    commits = _collect_commits(rev_range)
    groups, breaking, bump = _group_commits(commits)

    # Base the next version on the highest known version (tag or manifest), so a
    # repo that tags less often than it bumps its manifest never regresses.
    current = get_latest_tag_version(repo_root)
    for path, mdef in discover_manifests(repo_root):
        try:
            v = mdef.get_version(path.read_text(encoding="utf-8"))
        except Exception:
            v = None
        if v:
            current = _semver_max(current, v)
    current = current or "0.0.0"
    nextv = bump_semver(current, bump) or current
    changelog = _render_changelog(nextv, groups, breaking, datetime.date.today().isoformat())
    return {
        "from": last_tag or None,
        "current": current,
        "next": nextv,
        "bump": bump,
        "count": len(commits),
        "breaking": breaking,
        "changelog": changelog,
        "has_tags": bool(last_tag),
    }


# --- pull-request description (LLM) ---

def build_pr_info(base=None):
    base = base or detect_default_branch()
    branch = _git(["rev-parse", "--abbrev-ref", "HEAD"]).strip()
    rev_range = f"{base}..HEAD"
    commits = _collect_commits(rev_range)
    if not commits:
        return {"error": f"No commits on '{branch}' ahead of '{base}'.", "base": base, "branch": branch}

    diffstat = _git(["diff", "--stat", rev_range])[:2000]
    commit_text = "\n".join(
        f"- {c['subject']}" + (f"\n  {c['body']}" if c["body"] else "") for c in commits
    )
    system = (
        "You write concise GitHub pull request descriptions. Output ONLY a JSON object with "
        'keys "title" and "body". title: one concise line (<72 chars), conventional style, no '
        "trailing period. body: GitHub-flavored markdown with a one-paragraph '## Summary', a "
        "'## Changes' bullet list, and an optional '## Notes'. Do not wrap the JSON in code fences."
    )
    user = f"Base branch: {base}\nHead branch: {branch}\n\nCommits:\n{commit_text}\n\nDiff stat:\n{diffstat}"
    raw = call_llm(
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        echo=False, clean=False, temperature=0.3, max_tokens=900,
    )
    data = _extract_json(raw)
    if not isinstance(data, dict) or "title" not in data or "body" not in data:
        data = {"title": commits[0]["subject"], "body": "## Changes\n" + commit_text}
    data.update({"base": base, "branch": branch, "count": len(commits)})
    return data


# --- commit splitting (LLM proposes groups; the CLI executes) ---

def build_split_plan():
    staged = [f for f in _git(["diff", "--cached", "--name-only"]).split("\n") if f.strip()]
    if not staged:
        return {"error": "No staged changes. Stage files first with 'git add'.", "groups": [], "staged": []}

    parts = []
    for f in staged:
        d = _git(["diff", "--cached", "--unified=0", "--", f])
        parts.append(f"### {f}\n{d[:700]}")
    system = (
        "You split a set of staged changes into a minimal set of logical, independently-"
        "reviewable git commits using Conventional Commits. Output ONLY a JSON array; each item "
        'is {"message": "type(scope): subject", "files": ["path", ...], "reason": "short why"}. '
        "Every input file must appear in exactly one group. If the changes are cohesive, return a "
        "single group. Use lowercase imperative subjects with no trailing period."
    )
    user = ("Staged files and their diffs:\n\n" + "\n\n".join(parts))[:6000]
    raw = call_llm(
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        echo=False, clean=False, temperature=0.1, max_tokens=900,
    )
    data = _extract_json(raw)
    groups = data if isinstance(data, list) else (data.get("groups") if isinstance(data, dict) else None)
    if not isinstance(groups, list) or not groups:
        return {"error": "Could not parse a split plan from the model.", "groups": [], "staged": staged}

    assigned = []
    clean_groups = []
    for g in groups:
        if not isinstance(g, dict):
            continue
        files = [f for f in (g.get("files") or []) if f in staged and f not in assigned]
        if not files:
            continue
        assigned.extend(files)
        clean_groups.append({
            "message": str(g.get("message", "chore: update")).strip(),
            "files": files,
            "reason": str(g.get("reason", "")).strip(),
        })
    unassigned = [f for f in staged if f not in assigned]
    return {"groups": clean_groups, "staged": staged, "unassigned": unassigned}


def run_subcommand(argv):
    mode = argv[0]
    opts = argv[1:]

    def opt(name, default=None):
        if name in opts:
            i = opts.index(name)
            return opts[i + 1] if i + 1 < len(opts) else default
        return default

    try:
        if mode == "--scan":
            findings = scan_staged_secrets()
            print(json.dumps({"findings": findings, "count": len(findings)}))
            return 2 if findings else 0
        if mode == "--release":
            print(json.dumps(build_release_info()))
            return 0
        if mode == "--pr":
            print(json.dumps(build_pr_info(opt("--base"))))
            return 0
        if mode == "--split":
            print(json.dumps(build_split_plan()))
            return 0
        print(json.dumps({"error": f"unknown mode: {mode}"}))
        return 1
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


# ============================================================
#  MAIN
# ============================================================


def main():
    log_message("\n--- HOOK STARTED ---")

    if len(sys.argv) < 2:
        commit_msg_file = ".git/COMMIT_EDITMSG"
        log_message(
            "WARNING: No commit file provided, using default .git/COMMIT_EDITMSG"
        )
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

    print(f"[+] NeuroCommit v{NEURO_COMMIT_VERSION} started", flush=True)
    log_message(f"Commit file path: {commit_msg_file}")

    repo_root = find_repo_root()
    if repo_root:
        conflict_msg = check_conflicting_hooks(str(repo_root))
        if conflict_msg:
            reason = f"Conflict detected:\n{conflict_msg}"
            log_message(f"Conflict: {reason}")
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
    message = generate_commit_message(diff[:MAX_DIFF_LENGTH])

    if message is None:
        message = generate_fallback_message(diff[:MAX_DIFF_LENGTH])
        log_message(f"Fallback message generated ({len(message)} chars)")

    bumps = []

    if BUMP_VERSION and not os.environ.get("NEURO_COMMIT_SKIP_BUMP"):
        kind = determine_bump_kind(message)
        bumps = bump_project_version(kind, message)
        if bumps:
            footer_lines = [
                f"Bump version ({kind}):",
                *(f"  {f}: {o} → {n}" for f, o, n in bumps),
            ]
            for f, o, n in bumps:
                print(f"[+] Bumped {f}: {o} → {n} ({kind})")
            message += "\n\n" + "\n".join(footer_lines)

    if ADD_COAUTHOR:
        message += "\n\nCo-authored-by: NeuroCommit <autocommitrxgo@gmail.com>"

    commit_dir = os.path.dirname(commit_msg_file)
    if commit_dir and not os.path.exists(commit_dir):
        os.makedirs(commit_dir, exist_ok=True)

    with open(commit_msg_file, "w", encoding="utf-8") as f:
        f.write(message)
    log_message("Message written to commit file.")

    if bumps:
        repo_root = find_repo_root()
        if repo_root:
            old_head = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="ignore",
            ).stdout.strip()
            _amend_bump(bumps, repo_root, old_head)

    log_message("--- HOOK FINISHED ---\n")


if __name__ == "__main__":
    # `--<mode>` routes to a CLI subcommand (scan/release/pr/split); anything else
    # is the commit-message file path passed by the prepare-commit-msg hook.
    if len(sys.argv) > 1 and sys.argv[1].startswith("--"):
        sys.exit(run_subcommand(sys.argv[1:]))
    # Note: the log is size-capped + rotated in log_message() instead of being
    # wiped each run, so a crash from a previous run stays available to inspect.
    main()
