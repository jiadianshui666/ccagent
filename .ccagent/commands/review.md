---
description: Review code or workspace areas for bugs, regressions, and missing tests.
aliases: r
tags: review, safety
usage: /cmd review <path-or-topic>
args: required
confirm: true
---

# Review {{args}}

Review the requested code or workspace area.

Focus on:
- correctness bugs
- unsafe file or shell behavior
- missing tests
- regressions in CLI behavior

Start by inspecting relevant files. Report findings first, then summarize.
