#!/usr/bin/env bash
#
# Fail if a packaged Stoat.app is not properly signed.
#
# This exists because a green build is not evidence of a signed app.
# @electron/packager defaults @electron/osx-sign's continueOnError to true
# (dist/mac.js createSignOpts), so signAppIfSpecified downgrades a signing
# failure to a warning, and electron-forge's spinner UI hides it. That is how
# v1.5.3-adriel.1 shipped a .dmg whose bundle had `Sealed Resources=none` --
# no _CodeSignature at all -- while CI reported success. Apple Silicon rejects
# such a bundle outright as "damaged and can't be opened" (issue #1).
#
# Usage: verify-macos-signing.sh <path to Stoat.app>
#
# Set MACOS_SIGN_CN to the expected certificate common name to additionally
# require a certificate-pinned identity. Without it the script accepts an
# ad-hoc signature, which is launchable but whose designated requirement is a
# per-build cdhash that orphans the user's TCC grants on every update.
set -euo pipefail

APP="${1:-}"
EXPECTED_CN="${MACOS_SIGN_CN:-}"

fail() { echo "::error::$*" >&2; exit 1; }

[ -n "$APP" ] || fail "usage: $0 <path to .app>"
[ -d "$APP" ] || fail "no app bundle at $APP"

echo "=== codesign -dvvv $APP ==="
INFO="$(codesign -dvvv "$APP" 2>&1)" || fail "not signed at all: $APP"
echo "$INFO"

# 1. The bundle must carry a resource seal. This is the exact defect from #1.
if ! grep -q '^Sealed Resources' <<<"$INFO"; then
  fail "no Sealed Resources line -- bundle is unsealed"
fi
if grep -q 'Sealed Resources=none' <<<"$INFO"; then
  fail "Sealed Resources=none -- bundle was never sealed (this is the issue #1 defect)"
fi

# 2. Structural verification, nested code included. osx-sign runs this
#    internally, but here nothing can swallow the result.
codesign --verify --deep --strict --verbose=2 "$APP" \
  || fail "codesign --verify failed for $APP"

# 3. The native module behind global push-to-talk sits outside the asar
#    (auto-unpack-natives) and is dlopen'd at runtime, so it carries its own
#    signature. An unsigned .node here is what silently degrades push-to-talk
#    to focused-only.
UNPACKED="$APP/Contents/Resources/app.asar.unpacked"
if [ -d "$UNPACKED" ]; then
  while IFS= read -r node; do
    codesign --verify --strict --verbose=2 "$node" \
      || fail "unsigned native module: $node"
    echo "native module OK: ${node#"$APP/"}"
  done < <(find "$UNPACKED" -name '*.node')
fi

# 4. The designated requirement decides whether macOS still recognises this app
#    after an update, which is what keeps Accessibility / Input Monitoring --
#    and therefore global push-to-talk -- working across releases.
echo "=== designated requirement ==="
DR="$(codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => //p')"
echo "${DR:-<none>}"
[ -n "$DR" ] || fail "no designated requirement"

if [ -n "$EXPECTED_CN" ]; then
  grep -q "Authority=$EXPECTED_CN" <<<"$INFO" \
    || fail "expected signing authority '$EXPECTED_CN', not found"
  # an if, not `grep -q ... && fail`: that form leaves the good (no match) case
  # with a non-zero status, which is a live foot-gun if it ever ends up last
  if grep -qE 'flags=.*adhoc' <<<"$INFO"; then
    fail "ad-hoc signed despite a certificate being configured"
  fi
  grep -qE 'certificate|anchor' <<<"$DR" \
    || fail "designated requirement is not certificate-based: $DR"
  echo "certificate-pinned identity OK"
else
  echo "note: no MACOS_SIGN_CN set; ad-hoc signature accepted."
  echo "      TCC grants will not survive an update with this identity."
fi

# Record the requirement so future releases can be diffed against this one --
# if it ever changes, users silently lose their permissions.
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Designated requirement — \`$(basename "$APP")\`"
    echo
    echo '```'
    echo "$DR"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi

# 5. Informational only. spctl always rejects this app: notarization needs a
#    paid Developer ID. Printing it means an *unexpected* rejection reason
#    stays visible in the log.
echo "=== spctl (expected: rejected, not notarized) ==="
spctl --assess --type execute --verbose=4 "$APP" 2>&1 || true

echo "signature OK: $APP"
