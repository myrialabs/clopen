#!/bin/bash

# Validate commit message format
# Called by commit-msg hook

COMMIT_MSG_FILE=$1
COMMIT_MSG=$(cat "$COMMIT_MSG_FILE")

# Regex for conventional commits
# Format: type(scope): subject
# Examples: feat: add feature, fix(api): resolve bug
PATTERN="^(feat|fix|docs|chore|release)(\(.+\))?: .{1,72}"

if ! echo "$COMMIT_MSG" | grep -qE "$PATTERN"; then
    echo ""
    echo "❌ Invalid commit message format!"
    echo ""
    echo "Expected format:"
    echo "  <type>(<scope>): <subject>"
    echo ""
    echo "Types:"
    echo "  feat     - New feature"
    echo "  fix      - Bug fix"
    echo "  docs     - Documentation"
    echo "  chore    - Other changes (refactor, test, build, etc)"
    echo "  release  - Version release"
    echo ""
    echo "Examples:"
    echo "  feat: add database management"
    echo "  fix(terminal): resolve crash issue"
    echo "  docs(readme): update installation guide"
    echo "  chore: update dependencies"
    echo "  release: v0.0.2"
    echo ""
    echo "Your message:"
    echo "  $COMMIT_MSG"
    echo ""
    echo "See CONTRIBUTING.md for full guidelines"
    exit 1
fi

exit 0
