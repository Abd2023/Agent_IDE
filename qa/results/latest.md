# Regression Summary

- Mode: `full`
- Started: `2026-02-17T16:34:27.655Z`
- Finished: `2026-02-17T16:37:04.396Z`
- Service: `http://localhost:4000`
- Workspace: `C:\fun_project\fun_project_2\agent_do_stuff_here`
- Result: **32/41 passed** (78.05%), 9 failed

## Category Metrics

| Category | Total | Pass | Fail | Pass Rate |
|---|---:|---:|---:|---:|
| edit_existing | 10 | 7 | 3 | 70% |
| memory_session | 1 | 1 | 0 | 100% |
| create_new | 3 | 3 | 0 | 100% |
| browser_interaction | 5 | 5 | 0 | 100% |
| debug | 1 | 1 | 0 | 100% |
| workspace_management | 4 | 4 | 0 | 100% |
| code_generation_refactoring | 5 | 2 | 3 | 40% |
| documentation_understanding | 4 | 4 | 0 | 100% |
| debug_execution_loop | 4 | 3 | 1 | 75% |
| edge_cases_stress | 4 | 2 | 2 | 50% |

## Failed Tasks

- `edit_text_case_insensitive` Replace greeting with case variance
  - plan_success failed (implement)
  - Regex /hello world/i failed on index.html
- `edit_snake_border_collision` Snake wall collision should game over
  - Expected "wall collision -> game over" in snake_game.html
- `edit_no_overwrite_guard` Change title without deleting page body
  - Expected "<title>My Awesome Snake Game</title>" in snake_game.html
- `codegen_typesafety_any_to_interfaces` Replace any types with interfaces
  - plan_success failed (implement)
- `codegen_modernize_var_to_let_const` Convert var to let/const in src
  - plan_success failed (implement)
- `codegen_css_to_tailwind_header` Convert inline styles to Tailwind
  - plan_success failed (implement)
- `debug_lint_fix_loop` Run eslint and fix errors
  - plan_success failed (implement)
  - Regex /==/ unexpectedly matched src/lint-target.js
- `edge_security_dangerous_html` Replace dangerouslySetInnerHTML usage
  - plan_success failed (implement)
- `edge_large_scale_userdata_refactor` Rename userData to accountInfo safely
  - Expected "accountInfo" in src/refactor-target.ts
