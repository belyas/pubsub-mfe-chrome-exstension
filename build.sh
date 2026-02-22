#!/bin/bash
set -e

echo "Building PubSub DevTools Extension..."

# Ensure script runs from extension directory
cd "$(dirname "$0")"

# Clean dist
rm -rf dist
mkdir -p dist

# Compile TypeScript
# Use the binary directly (not `pnpm exec`) because `pnpm exec` always runs from
# the workspace root and would pick up the root tsconfig.json (noEmit: true).
echo "Compiling TypeScript..."
../node_modules/.bin/tsc -p tsconfig.json

# Copy static assets
echo "Copying static files..."
cp manifest.json dist/
cp panel.html dist/
cp panel.css dist/

# Create devtools.html wrapper (kept explicit in build output)
cat > dist/devtools.html << 'EOF'
<!DOCTYPE html>
<html>
<head>
  <script type="module" src="devtools.js"></script>
</head>
<body></body>
</html>
EOF

# Copy icons when available
for size in 16 48 128; do
  if [ ! -f "icon-${size}.png" ]; then
    echo "⚠️  Warning: icon-${size}.png not found"
  else
    cp "icon-${size}.png" dist/
  fi
done

echo "✅ Build complete! Extension is in ./dist"
echo "📦 Load unpacked extension from: $(pwd)/dist"
