import os
import sys
import subprocess
# from dotenv import load_dotenv
import traceback
from datetime import datetime, timezone
import json
import pathspec


USAGE_FILE = ".githooks/token_usage.json"
DAILY_QUOTA = 500_000


def _load_usage():
    if os.path.exists(USAGE_FILE):
        with open(USAGE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            today = datetime.now(timezone.utc).date().isoformat()
            if data.get("date") != today:
                return {"date": today, "models": {}}
            return data
    today = datetime.now(timezone.utc).date().isoformat()
    return {"date": today, "models": {}}


def _save_usage(data):
    with open(USAGE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def record_token_usage(model: str, tokens: int):
    data = _load_usage()
    data["models"][model] = data["models"].get(model, 0) + tokens
    _save_usage(data)


def has_quota(model: str, needed: int) -> bool:
    data = _load_usage()
    used = data["models"].get(model, 0)
    return (used + needed) <= DAILY_QUOTA


def get_remaining_quota(model: str) -> int:
    data = _load_usage()
    used = data["models"].get(model, 0)
    return max(0, DAILY_QUOTA - used)


def count_tokens(text: str, model_name: str) -> int:
    """
    Быстрая эвристика: 1 токен ≈ 4 символа.
    Точность достаточна для контроля квоты.
    """
    return max(1, len(text) // 4)


LOG_FILE = os.path.join(os.path.dirname(__file__), '..', 'ai_commit_debug.log')


def log_message(message: str) -> None:
    """
    Функция, которая записывает логи в файл
    :param message: Сообщение
    """
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"{message}\n")


# load_dotenv()

MODELS_TO_TRY = ["mistralai/Magistral-Small-2506", "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8", "google/gemma-3-270m-it", "mistralai/Devstral-Small-2505", "meta-llama/Llama-3.3-70B-Instruct", "deepseek-ai/DeepSeek-R1-0528"]

MAX_DIFF_LENGTH = 3000
REQUEST_TIMEOUT = 15

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
    
    "BAD EXAMPLES (NEVER do this):\n"
    "  'update README.md' → too vague\n"
    "  'Добавлено много документации' → not specific\n"
    "  'Merge branch ...' → ignore merge-related changes\n\n"
    
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
    """
    Функция, которая записывает ошибку как комментарий в файл коммита
    """
    with open(msg_file, "w", encoding="utf-8") as f:
        f.write("# ❌ AI COMMIT HOOK FAILED\n")
        f.write(f"# Reason: {err_msg}\n") 


def read_commitignore(filepath='.commitignore') -> list:
    ignored = []
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    ignored.append(line)
    except FileNotFoundError:
        pass 
    return ignored


def get_staged_diff():
    try:
        result = subprocess.run(
            ["git", "diff", "--cached", "--name-only"],
            capture_output=True, text=True, encoding='utf-8', errors='ignore'
        )
        if result.returncode != 0:
            log_message(f"Failed to get staged files: {result.stderr}")
            return ""

        staged_files = result.stdout.strip().splitlines()
        if not staged_files:
            return ""
        
        exclude_patterns = read_commitignore()
        spec = pathspec.GitIgnoreSpec.from_lines(exclude_patterns)

        relevant_files = [f for f in staged_files if not spec.match_file(f)]

        if not relevant_files:
            log_message("No relevant staged files (only hook/config files changed).")
            return ""
        
        log_message(f"Staged files: {staged_files}")
        log_message(f"Relevant files: {relevant_files}")

        result = subprocess.run(
            ["git", "diff", "--cached", "--no-color", "--unified=0"] + relevant_files,
            capture_output=True, text=True, encoding='utf-8', errors='ignore'
        )

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
            elif current_file and line.startswith(("+", "-")) and not line.startswith(("+++", "---")):
                if len(line) > 1:
                    filtered.append(line)

        return "\n".join(filtered).strip()

    except Exception as e:
        log_message(f"Error in get_staged_diff: {e}\n{traceback.format_exc()}")
        return ""


def generate_commit_message(diff):
    import openai
    
    # api_key = os.getenv("OPENAI_API_KEY")

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        # return "ERROR: OPENAI_API_KEY is missing"
        log_message("ERROR: OPENAI_API_KEY is missing")
        sys.exit(1)

    client = openai.OpenAI(api_key=api_key, base_url="https://api.intelligence.io.solutions/api/v1/")

    user_prompt = f"Analyze this diff and create a commit message:\n\n---\n{diff}"
 
    for model in MODELS_TO_TRY:
        try:
            system_tokens = count_tokens(SYSTEM_PROMPT, model)
            user_tokens = count_tokens(user_prompt, model)
            estimated_input = system_tokens + user_tokens
            estimated_total = estimated_input + 100

            if not has_quota(model, estimated_total):
                remaining = get_remaining_quota(model)
                log_message(f"Skipping {model}: not enough quota (need {estimated_total}, have {remaining})")
                continue

            log_message(f"Attempting model: {model} (est. tokens: {estimated_total})")

            response = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt}
                ],
                temperature=0.2,
                max_tokens=200,
                timeout=REQUEST_TIMEOUT
            )

            message = response.choices[0].message.content.strip()

            if not message or message.startswith("#") or len(message.strip()) < 10:
                log_message(f"Generated message too short or invalid: {repr(message)}")
                continue

            completion_tokens = count_tokens(message, model)
            total_tokens = estimated_input + completion_tokens

            record_token_usage(model, total_tokens)
            log_message(f"SUCCESS with {model}. Tokens: {total_tokens} (in: {estimated_input}, out: {completion_tokens})")
            return message

        except Exception as e:
            approx_tokens = estimated_input + 50
            record_token_usage(model, approx_tokens)
            log_message(f"FAILURE with {model}. Estimated tokens spent: {approx_tokens}. Error: {e}")
            continue

    return "ERROR: All models failed or quota exceeded"


def main():
    log_message("\n--- HOOK STARTED ---")

    if len(sys.argv) < 2:
        commit_msg_file = ".git/COMMIT_EDITMSG"
        log_message("WARNING: No commit file provided, using default .git/COMMIT_EDITMSG")
    else:
        commit_msg_file = sys.argv[1]

    try:
        with open(commit_msg_file, 'r', encoding='utf-8') as f:
            existing_content = f.read().strip()
    except Exception as e:
        existing_content = ""
        log_message(f"Could not read commit file: {e}")

    if existing_content and not existing_content.startswith("#"):
        log_message("User-provided commit message detected. Skipping AI generation.")
        sys.exit(0)

    print("[+] Auto Commit started")
    log_message(f"Commit file path: {commit_msg_file}")

    diff = get_staged_diff()

    if not diff:
        try:
            result = subprocess.run(
                ["git", "diff", "--cached", "--name-only"],
                capture_output=True, text=True, encoding='utf-8', errors='ignore'
            )
            staged_files = result.stdout.strip().splitlines() if result.returncode == 0 else []
        except Exception as e:
            staged_files = []
            log_message(f"Failed to check staged files: {e}")

        if staged_files:
            reason = "All staged files are ignored (listed in .commitignore)"
            write_error_to_commit(commit_msg_file, reason)
            log_message(f"INFO: {reason}. Wrote notice to commit file.")
        else:
            log_message("Exit: No staged changes found.")
            sys.exit(0)
    else:
        log_message(f"Diff found (length: {len(diff)}).")
        print("[+] Comment generation started")
        message = generate_commit_message(diff[:MAX_DIFF_LENGTH])

        if message and not message.startswith("ERROR:"):
            with open(commit_msg_file, 'w', encoding='utf-8') as f:
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
