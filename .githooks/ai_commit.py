import os
import sys
import subprocess
import openai
from dotenv import load_dotenv
import traceback

LOG_FILE = os.path.join(os.path.dirname(__file__), '..', 'ai_commit_debug.log')

def log_message(message):
    """Записывает сообщение в лог-файл."""
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"{message}\n")

load_dotenv()

MODELS_TO_TRY = ["mistralai/Magistral-Small-2506", "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8", "google/gemma-3-270m-it", "mistralai/Devstral-Small-2505", "meta-llama/Llama-3.3-70B-Instruct", "deepseek-ai/DeepSeek-R1-0528"]

MAX_DIFF_LENGTH = 3000
REQUEST_TIMEOUT = 15

SYSTEM_PROMPT = (
    'Generate a Conventional Commit message.\n'
    'RULES:\n'
    '- Subject: English, max 50 chars, lowercase.\n'
    '- Body: Russian, explains the "why", not big, but not too small.\n'
    '- Output: Raw text only. No markdown or explanations.\n'
    'EXAMPLE:\n'
    'feat(auth): implement session logic\n'
    '\n'
    'Добавлена логика сессий с использованием JWT для аутентификации пользователей.'
)


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

        EXCLUDE_PATTERNS = [
            ".githooks/",
            "ai_commit.py",
            "ai_commit_debug.log",
            ".env",
            ".env.local",
            "commit-msg",
            "prepare-commit-msg",
        ]

        relevant_files = []
        for f in staged_files:
            should_exclude = False
            for pattern in EXCLUDE_PATTERNS:
                if f.startswith(pattern) or f == pattern:
                    should_exclude = True
                    break
            if not should_exclude:
                relevant_files.append(f)

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
                    skip = any(current_file.startswith(p) or current_file == p for p in EXCLUDE_PATTERNS)
                    if skip:
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
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        log_message("ERROR: OPENAI_API_KEY not found in environment.")
        return None
    log_message(f"API key found, starting with first {len(api_key[:5])} chars: {api_key[:5]}...")

    client = openai.OpenAI(api_key=api_key, base_url="https://api.intelligence.io.solutions/api/v1/")
    user_prompt = f"Analyze this diff and create a commit message:\n\n---\n{diff}"

    for model in MODELS_TO_TRY:
        try:
            log_message(f"Attempting model: {model}")
            response = client.chat.completions.create(
                model=model, messages=[{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user_prompt}],
                temperature=0.2, max_tokens=200, timeout=REQUEST_TIMEOUT
            )
            message = response.choices[0].message.content.strip()
            log_message(f"SUCCESS with {model}. Message: {message}")
            return message
        except Exception as e:
            log_message(f"FAILURE with {model}. Error: {e}\n{traceback.format_exc()}")
    
    log_message("All models failed.")
    return None

def main():
    log_message("\n--- HOOK STARTED ---")
    if len(sys.argv) < 2:
        log_message("Exit: Not enough arguments.")
        sys.exit(0)
    
    commit_msg_file = sys.argv[1]
    log_message(f"Commit file path: {commit_msg_file}")

    diff = get_staged_diff()
    if not diff:
        log_message("Exit: No staged changes found.")
        sys.exit(0)
    log_message(f"Diff found (length: {len(diff)}).")

    message = generate_commit_message(diff[:MAX_DIFF_LENGTH])

    if message:
        with open(commit_msg_file, 'w', encoding='utf-8') as f:
            f.write(message)
        log_message("Message written to commit file.")
    else:
        log_message("Exit: No message was generated.")
    log_message("--- HOOK FINISHED ---\n")

if __name__ == "__main__":
    if os.path.exists(LOG_FILE):
        os.remove(LOG_FILE)
    main()
