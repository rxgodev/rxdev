import sys
import subprocess
import os

hook_dir = os.path.dirname(__file__)
script_path = os.path.join(hook_dir, 'ai_commit.py')

commit_msg_file = sys.argv[1]

subprocess.run([sys.executable, script_path, commit_msg_file])
