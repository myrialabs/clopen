#!/bin/bash

# Validate branch name format
# Called by pre-push hook

BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Allowed branch patterns:
# - main, dev (protected branches)
# - feature/*, fix/*, docs/*, chore/*
PATTERN="^(main|dev|feature|fix|docs|chore)/[a-z0-9-]+$"

# Allow protected branches
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "dev" ]; then
    exit 0
fi

# Validate branch name
if ! echo "$BRANCH" | grep -qE "$PATTERN"; then
    echo ""
    echo "❌ Invalid branch name: $BRANCH"
    echo ""
    echo "Expected format:"
    echo "  <type>/<short-description>"
    echo ""
    echo "Types:"
    echo "  feature  - New feature"
    echo "  fix      - Bug fix"
    echo "  docs     - Documentation"
    echo "  chore    - Other changes"
    echo ""
    echo "Rules:"
    echo "  - All lowercase"
    echo "  - Use hyphens (not spaces or underscores)"
    echo "  - Short and descriptive"
    echo ""
    echo "Examples:"
    echo "  feature/add-git-management"
    echo "  fix/terminal-crash"
    echo "  docs/update-readme"
    echo "  chore/update-deps"
    echo ""
    echo "See CONTRIBUTING.md for full guidelines"
    exit 1
fi

exit 0
