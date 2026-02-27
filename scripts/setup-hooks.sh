#!/bin/bash

##############################################
# Setup Git Hooks for Clopen
#
# This script installs git hooks to validate:
# - Commit message format
# - Code quality (type check + lint)
# - Branch naming
# - Build success (on main/dev push)
##############################################

echo ""
echo "🔧 Installing Git Hooks..."
echo ""

HOOKS_DIR=".git/hooks"

# ============================================
# HOOK 1: Validate Commit Message Format
# ============================================
echo "📝 Creating commit-msg hook..."

cat > "$HOOKS_DIR/commit-msg" << 'EOF'
#!/bin/bash
# Validates commit message follows convention
bash scripts/validate-commit-msg.sh "$1"
exit $?
EOF

chmod +x "$HOOKS_DIR/commit-msg"
echo "   ✅ commit-msg hook created"

# ============================================
# HOOK 2: Type Check + Lint Before Commit
# ============================================
echo "🔍 Creating pre-commit hook..."

cat > "$HOOKS_DIR/pre-commit" << 'EOF'
#!/bin/bash
echo ""
echo "🔍 Running pre-commit checks..."

# Type check with Bun
echo "   📝 Type checking..."
bun run check
if [ $? -ne 0 ]; then
    echo ""
    echo "   ❌ Type check failed"
    exit 1
fi

# Lint with Bun
echo "   🔍 Linting..."
bun run lint
if [ $? -ne 0 ]; then
    echo ""
    echo "   ❌ Lint failed"
    exit 1
fi

echo "   ✅ All checks passed"
echo ""
exit 0
EOF

chmod +x "$HOOKS_DIR/pre-commit"
echo "   ✅ pre-commit hook created"

# ============================================
# HOOK 3: Branch Name + Build Test
# ============================================
echo "🚀 Creating pre-push hook..."

cat > "$HOOKS_DIR/pre-push" << 'EOF'
#!/bin/bash
echo ""
echo "🚀 Running pre-push checks..."

# Validate branch name
echo "   🌿 Checking branch name..."
bash scripts/validate-branch-name.sh
if [ $? -ne 0 ]; then
    exit 1
fi

# Get current branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Build test for protected branches
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "dev" ]; then
    echo "   🔨 Testing build (protected branch)..."
    bun run build
    if [ $? -ne 0 ]; then
        echo ""
        echo "   ❌ Build failed"
        exit 1
    fi
fi

echo "   ✅ All checks passed"
echo ""
exit 0
EOF

chmod +x "$HOOKS_DIR/pre-push"
echo "   ✅ pre-push hook created"

# ============================================
# Make Validation Scripts Executable
# ============================================
chmod +x scripts/validate-commit-msg.sh
chmod +x scripts/validate-branch-name.sh

# ============================================
# Done!
# ============================================
echo ""
echo "✅ Git hooks installed successfully!"
echo ""
echo "┌─────────────────────────────────────────────┐"
echo "│ Hooks Installed:                            │"
echo "├─────────────────────────────────────────────┤"
echo "│ • commit-msg  → Validate message format     │"
echo "│ • pre-commit  → Type check + Lint           │"
echo "│ • pre-push    → Branch name + Build test    │"
echo "└─────────────────────────────────────────────┘"
echo ""
echo "📚 See CONTRIBUTING.md for commit/branch conventions"
echo ""
echo "⚠️  To bypass (not recommended):"
echo "   git commit --no-verify"
echo "   git push --no-verify"
echo ""
