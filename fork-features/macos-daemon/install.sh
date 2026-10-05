#!/bin/zsh
# Build a pinned fork commit and run it as the operator's Mac daemon.
# Usage: fork-features/macos-daemon/install.sh [--session] <git-ref>
#
# Default: run under a launchd LaunchAgent. The checkouts the agents work in live on the
# separate ~/Ext APFS volume, and macOS privacy (TCC) denies launchd-started processes
# file access there until the operator allows the pinned node binary once (System Settings >
# Privacy & Security). Until then the job starts but cannot read the volume.
# --session: skip launchd and restart the daemon detached from the calling terminal, which
# inherits that terminal's file access. It does not survive a logout or reboot.
set -euo pipefail

mode=launchd
if [[ "${1:-}" == "--session" ]]; then mode=session; shift; fi
ref=${1:?usage: install.sh [--session] <git-ref>}
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
  # CI=true: lefthook's npm postinstall would otherwise run `lefthook install -f` and
  # rewrite the operator's global git hooks (core.hooksPath) to point into this release.
  /bin/zsh -i -l -c 'cd "$1" && CI=true npm ci --no-audit --no-fund && npm run build:server' _ "$release"
fi
resolved_node=$(/bin/zsh -i -l -c 'cd "$1" && node -p process.execPath' _ "$release" | tail -n 1)
[[ -x "$resolved_node" ]] || { echo "node not resolved for $release" >&2; exit 1; }
# Copy the interpreter off ~/Ext: macOS denies sshd sessions file access to that volume,
# and the router's SSH gate runs this wrapper (mouriya-s-lab/paseo#40).
node_bin="$root/node/$("$resolved_node" -v)/node"
if [[ ! -x "$node_bin" ]]; then
  mkdir -p "${node_bin:h}"
  cp -p "$resolved_node" "$node_bin.next"
  mv -f "$node_bin.next" "$node_bin"
fi

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
if [[ "$mode" == launchd ]]; then
  launchctl bootstrap "$domain" "$plist"
else
  # A clean login environment, as launchd would give, rather than the caller's shell state.
  env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh TERM=xterm-256color \
    PASEO_NODE_ENV=production PASEO_CLI="$root/bin/paseo" \
    /bin/zsh -i -l -c '"$1" daemon stop --home "$2" >/dev/null 2>&1 || true; "$1" daemon start --home "$2" --json' \
    _ "$root/bin/paseo" "$paseo_home"
fi

# The router's gate (`paseo iac-gate`) runs its checks in this plugin, inside the daemon,
# which can read the checkouts (mouriya-s-lab/paseo#40). Re-point it at this release.
plugin="$release/fork-features/iac-workspace-gate/plugin"
installed=false
for _ in {1..30}; do
  "$root/bin/paseo" plugin remove iac-workspace-gate >/dev/null 2>&1 || true
  if "$root/bin/paseo" plugin install "$plugin" --json >/dev/null 2>&1; then installed=true; break; fi
  sleep 2
done
[[ "$installed" == true ]] || { echo "iac-workspace-gate plugin install failed" >&2; exit 1; }
echo "mode=$mode release=$sha node=$node_bin plist=$plist"
