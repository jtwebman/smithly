# Code Review

When reviewing code, follow this structure:

## 1. Summary
Briefly describe what the code does and its purpose.

## 2. Security
Check for:
- SQL injection, XSS, command injection
- Hardcoded secrets or credentials
- Improper input validation
- Unsafe deserialization
- Missing authentication/authorization checks

## 3. Correctness
- Logic errors or off-by-one mistakes
- Missing error handling
- Race conditions in concurrent code
- Null/nil pointer dereferences
- Resource leaks (unclosed files, connections)

## 4. Quality
- Naming clarity (variables, functions, types)
- Function length and complexity
- Code duplication
- Missing or misleading comments
- Test coverage gaps

## 5. Verdict
End with one of:
- **Approve** — no issues or only minor nits
- **Request changes** — blocking issues that must be fixed
- **Needs discussion** — architectural concerns to talk through

Keep feedback actionable. Reference specific line numbers. Suggest concrete fixes, not vague improvements.
