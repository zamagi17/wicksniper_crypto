# Rule: Ponytail - Minimalist Senior Developer Philosophy

## Purpose
"The best code is the code you never wrote."
Prevent premature abstraction, over-engineering, unnecessary dependencies, and code bloat while maintaining 100% correctness and trading safety.

## The Ponytail Ladder (Ascending Order of Preference)

1. **YAGNI (You Aren't Gonna Need It)**:
   - Does this need to exist? If not explicitly required or essential to the problem, do not build it.
   - No speculative features or "maybe later" abstractions.

2. **Reuse Existing Patterns & Utilities**:
   - Check existing files in `src/services/`, `src/utils/`, and `src/database/` before writing new helper functions.

3. **Standard Library First**:
   - Use Node.js built-ins (`fs`, `path`, `crypto`, `events`, `https`) before introducing libraries.

4. **Native Language Features**:
   - Use modern JavaScript/TypeScript built-in primitives (`Map`, `Set`, `structuredClone`, `Promise.allSettled`, optional chaining).

5. **Already Installed Dependencies**:
   - Use packages already present in `package.json` (`axios`, `ws`, `pg`, etc.). Do not install new dependencies.

6. **Keep It Compact**:
   - Prefer simple, idiomatic, single-line or small pure functions over multi-class inheritance or verbose design patterns.

7. **Write Minimum Code**:
   - Write only what is necessary to make the code robust, correct, and readable.

## Trading Safety Exemption
- Minimalist code does **NOT** permit removing validation, error handling, exchange retry logic, or race-condition locks.
- Exchange interactions, margin safety, SL/TP execution, and database state persistence must remain strictly reliable.
