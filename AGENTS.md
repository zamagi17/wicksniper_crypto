# Project Rules: RTK & Ponytail Guidelines

This project strictly enforces two complementary guidelines to minimize LLM token consumption and maintain clean, reliable, and zero-bloat code:
1. **RTK (Rust Token Killer)**: Aggressive token conservation, surgical inspection, and high signal-to-noise ratio.
2. **Ponytail**: Minimalist senior engineering ("The best code is the code you never wrote").

---

## 1. RTK (Token Killer) Rules

### A. Terminal & Command Output Minimization
- **High-Signal Commands Only**: Never execute commands that dump unconstrained or noisy terminal output.
  - Use concise git commands: `git status -s`, `git diff --stat`, `git log -n 5 --oneline`.
  - In PowerShell / Bash, avoid unrestricted dumps. Filter or limit output (e.g., `Select-Object -First 20`, `head -n 20`).
- **No Build Spam**: Run builds (`npm run build`, `tsc`) only when validation is required. Do not repeat identical commands if state has not changed.

### B. Surgical File Inspection
- **Never Dump Whole Large Files**: Do not read 500+ lines of code into context when only inspecting a function or block. Always use `StartLine` and `EndLine` with narrow ranges (typically 50–150 lines).
- **Targeted Search First**: Use `grep_search` with specific terms or regex to pinpoint exact locations before opening files.
- **Compact Responses**: Keep agent explanations concise and focused on rationale, file links, and key decisions. Avoid echoing large chunks of unchanged code or repeating entire artifacts in chat.

### C. Surgical Diffs & Edits
- **Contiguous Edits**: Use `replace_file_content` or `multi_replace_file_content` with minimal, precise replacement chunks.
- **Never Overwrite Intact Files**: Never replace an entire multi-thousand line file with `write_to_file` when modifying or fixing a single function.

---

## 2. Ponytail (Minimalist Senior Engineering) Rules

> *"The best code is the code you never wrote."*

### The Decision Ladder (Follow strictly in ascending order):
1. **Does this need to exist? (YAGNI)**
   - If a feature, helper function, extra wrapper, or abstraction was not requested or strictly required, **do not write it**.
   - Resist the urge to "future-proof" for hypothetical scenarios that don't exist today.
2. **Already in this codebase?**
   - Before writing any new logic, check if a utility, helper, type, or pattern already exists in `src/services/` or `src/utils/`. Reuse it.
3. **Can the standard library (Node.js built-ins) do it?**
   - Use built-in modules (`fs`, `path`, `crypto`, `https`, `events`) before reaching for third-party libraries.
4. **Can native TypeScript/JavaScript features do it?**
   - Leverage `Map`, `Set`, `Array.prototype` methods, `structuredClone()`, optional chaining (`?.`), and nullish coalescing (`??`).
5. **Is there an already installed dependency?**
   - Check `package.json`. If `axios`, `ws`, or `pg` can do the job, never install an additional package.
6. **Can it be written in one or a few clean lines?**
   - Prefer compact, expressive, readable code over multi-layer OOP boilerplate or unnecessary class hierarchies.
7. **Only then:**
   - Write the absolute minimum code that satisfies the requirement with 100% correctness.

### Safety & Trading Integrity Boundaries
- **No Compromise on Critical Reliability**: Minimalism does **not** mean skipping validation.
- All financial calculations, exchange error handlers, margin checks, position locks, and SL/TP triggers must remain strictly typed, safe against race conditions, and fully guarded against exceptions.
- Never strip error handling, fallback polling, or audit trails in the name of brevity.
