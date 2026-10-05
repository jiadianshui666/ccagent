---
description: Run the project verification workflow and summarize failures first.
tags: test, verification
usage: /cmd test
---

# Test workflow

Run the project verification workflow.

Steps:
- inspect package.json if needed
- run npm run build
- run npm test
- summarize failures first if anything fails
