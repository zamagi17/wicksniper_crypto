# Rule: RTK (Rust Token Killer) - High-Signal, Minimal-Token Execution

## Purpose
Enforce aggressive token economy across all agent actions, terminal commands, context loading, and responses.

## Instructions for Agents

1. **Terminal Command Optimization**:
   - Always run commands with concise output flags.
   - For git: `git status -s`, `git diff --stat`, `git log -n 5 --oneline`.
   - Never run unconstrained commands that might stream hundreds of lines of output.
   - When checking files/directories, avoid recursive large dumps.

2. **Context Window Optimization**:
   - Never load entire large files (> 300 lines) into context unless explicitly requested.
   - Use `grep_search` to find exact lines/functions.
   - Use `view_file` with targeted `StartLine` and `EndLine` (≤ 150 lines per slice).

3. **Code Editing Economy**:
   - Always use `replace_file_content` or `multi_replace_file_content` for surgical changes.
   - Never use `write_to_file` to rewrite an existing file completely just to edit a few lines.

4. **Response Concurrency & Conciseness**:
   - Provide direct, high-signal explanations.
   - Do not repeat long code blocks or re-paste entire artifacts into the conversation.
