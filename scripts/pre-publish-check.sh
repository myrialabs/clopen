#!/bin/bash

##############################################
# Pre-Publish Validation
#
# Run this before publishing to npm:
#   bash scripts/pre-publish-check.sh
#
# Validates:
# - On main/dev branch
# - No uncommitted changes
# - Type check passes
# - Lint passes
# - Build succeeds
##############################################

echo ""
echo "┌─────────────────────────────────────────────┐"
echo "│                                             │"
echo "│        🔍 Pre-Publish Validation            │"
echo "│                                             │"
echo "└─────────────────────────────────────────────┘"
echo ""

# ============================================
# CHECK 1: Current Branch
# ============================================
echo "1️⃣  Checking branch..."

BRANCH=$(git rev-parse --abbrev-ref HEAD)

if [ "$BRANCH" != "main" ] && [ "$BRANCH" != "dev" ]; then
    echo "   ❌ Must publish from main or dev branch"
    echo "   Current: $BRANCH"
    echo ""
    exit 1
fi

echo "   ✅ Branch: $BRANCH"
echo ""

# ============================================
# CHECK 2: Uncommitted Changes
# ============================================
echo "2️⃣  Checking for uncommitted changes..."

if ! git diff-index --quiet HEAD --; then
    echo "   ❌ You have uncommitted changes"
    echo ""
    git status --short
    echo ""
    echo "   Commit or stash changes first"
    echo ""
    exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
    echo "   ❌ Working directory not clean"
    echo ""
    git status --short
    echo ""
    exit 1
fi

echo "   ✅ No uncommitted changes"
echo ""

# ============================================
# CHECK 3: Type Check
# ============================================
echo "3️⃣  Running type check..."

bun run check > /dev/null 2>&1

if [ $? -ne 0 ]; then
    echo "   ❌ Type check failed"
    echo ""
    bun run check
    echo ""
    exit 1
fi

echo "   ✅ Type check passed"
echo ""

# ============================================
# CHECK 4: Lint
# ============================================
echo "4️⃣  Running lint..."

bun run lint > /dev/null 2>&1

if [ $? -ne 0 ]; then
    echo "   ❌ Lint failed"
    echo ""
    bun run lint
    echo ""
    exit 1
fi

echo "   ✅ Lint passed"
echo ""

# ============================================
# CHECK 5: Build
# ============================================
echo "5️⃣  Testing build..."

bun run build > /dev/null 2>&1

if [ $? -ne 0 ]; then
    echo "   ❌ Build failed"
    echo ""
    bun run build
    echo ""
    exit 1
fi

# Verify dist exists
if [ ! -d "dist" ]; then
    echo "   ❌ dist/ directory not found"
    echo ""
    exit 1
fi

echo "   ✅ Build successful"
echo ""

# ============================================
# All Checks Passed!
# ============================================
echo "┌─────────────────────────────────────────────┐"
echo "│                                             │"
echo "│        ✅ All Checks Passed!                │"
echo "│                                             │"
echo "└─────────────────────────────────────────────┘"
echo ""
echo "Ready to publish:"
echo ""
echo "  bun publish --dry-run    # Preview what will be published"
echo "  bun publish              # Publish to npm"
echo ""
