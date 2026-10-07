// The fork release tag (`X.Y.Z-fork.N`) is allocated by
// fork-features/release/fork-release-version.mjs in CI, after the source is
// fixed, so package.json only carries the upstream base version. The Docker
// builds inline the tag here. It is display-only: the daemon handshake,
// changelog matching, and version-mismatch checks keep the base version from
// resolveAppVersion().
export function resolveForkReleaseVersion(): string | null {
  // Expo inlines EXPO_PUBLIC_* only for this literal member access.
  const value = process.env.EXPO_PUBLIC_PASEO_FORK_VERSION?.trim();
  return value ? value : null;
}
