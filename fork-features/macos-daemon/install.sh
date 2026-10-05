#!/bin/zsh
# Build a pinned fork commit and run it as the operator's Mac daemon under launchd.
# Usage: fork-features/macos-daemon/install.sh <git-ref>
set -euo pipefail

ref=${1:?usage: install.sh <git-ref>}
root="$HOME/.local/share/paseo-fork-daemon"
label="sh.paseo.fork-daemon"
plist="$HOME/Library/LaunchAgents/$label.plist"
paseo_home="${PASEO_HOME:-$HOME/.paseo}"
remote="https://github.com/mouriya-s-lab/paseo.git"

mkdir -p "$root/releases" "$root/bin" "$HOME/Library/Logs" "$HOME/Library/LaunchAgents"
if [[ ! -d "$root/repo/.git" ]]; then
  git clone --quiet "$remote" "$root/repo"
fi
git -C "$root/repo" fetch --quiet --tags origin '+refs/heads/*:refs/remotes/origin/*'
sha=$(git -C "$root/repo" rev-parse --verify "$ref^{commit}" 2>/dev/null ||
  git -C "$root/repo" rev-parse --verify "origin/$ref^{commit}")
release="$root/releases/$sha"

# The release must build with the toolchain the checkout pins (.tool-versions), resolved
# through the operator's login shell exactly as the daemon will see it.
if [[ ! -f "$release/packages/server/dist/scripts/supervisor-entrypoint.js" ]]; then
  rm -rf "$release"
  git -C "$root/repo" worktree prune
  git -C "$root/repo" worktree add --quiet --detach "$release" "$sha"
  # mise refuses an untrusted checkout config, which would leave node unresolved.
  if command -v mise >/dev/null 2>&1; then mise trust --quiet "$release"; fi
  /bin/zsh -i -l -c 'cd "$1" && npm ci --no-audit --no-fund && npm run build:server' _ "$release"
fi
node_bin=$(/bin/zsh -i -l -c 'cd "$1" && node -p process.execPath' _ "$release" | tail -n 1)
[[ -x "$node_bin" ]] || { echo "node not resolved for $release" >&2; exit 1; }

# The wrapper is what agents (PASEO_CLI) and the router's SSH gate call; a non-login SSH
# shell has no node on PATH, so it pins the absolute interpreter.
cat > "$root/bin/paseo.next" <<EOF
#!/bin/sh
exec "$node_bin" --disable-warning=DEP0040 "$root/current/packages/cli/dist/index.js" "\$@"
EOF
chmod 755 "$root/bin/paseo.next"
mv -f "$root/bin/paseo.next" "$root/bin/paseo"
ln -sfh "$release" "$root/current"

# Like the desktop app, hydrate the operator's login-shell environment (PATH for omp/bun/gh,
# SSH_AUTH_SOCK, tool config) instead of freezing a hand-picked subset into the plist.
cat > "$plist.next" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-i</string><string>-l</string><string>-c</string>
    <string>exec "\$PASEO_FORK_NODE" --disable-warning=DEP0040 "\$PASEO_FORK_ROOT/current/packages/server/dist/scripts/supervisor-entrypoint.js"</string>
  </array>
  <key>WorkingDirectory</key><string>$root/current</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PASEO_FORK_NODE</key><string>$node_bin</string>
    <key>PASEO_FORK_ROOT</key><string>$root</string>
    <key>PASEO_HOME</key><string>$paseo_home</string>
    <key>PASEO_NODE_ENV</key><string>production</string>
    <key>PASEO_CLI</key><string>$root/bin/paseo</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/paseo-fork-daemon.out.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/paseo-fork-daemon.err.log</string>
</dict>
</plist>
EOF
mv -f "$plist.next" "$plist"

domain="gui/$(id -u)"
if launchctl print "$domain/$label" >/dev/null 2>&1; then
  launchctl bootout "$domain/$label"
  # bootout returns before the job is fully removed; bootstrap fails while it lingers.
  for _ in {1..30}; do launchctl print "$domain/$label" >/dev/null 2>&1 || break; sleep 1; done
fi
launchctl bootstrap "$domain" "$plist"
echo "release=$sha node=$node_bin plist=$plist"
