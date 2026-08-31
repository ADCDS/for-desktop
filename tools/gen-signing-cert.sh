#!/usr/bin/env bash
#
# Generate the self-signed certificate chain used to sign macOS builds, and
# print the two repo secrets the release workflow needs.
#
# Why bother, given this buys no Gatekeeper trust:
#
#   macOS records an app's *designated requirement* (DR) alongside a granted
#   permission and re-checks it on every launch. For an ad-hoc signature the DR
#   is a bare cdhash -- a hash of that exact build -- so every release produces
#   a new identity, the stored Accessibility / Input Monitoring grant no longer
#   matches, and global push-to-talk silently dies. Signing with a real
#   certificate makes the DR pin the certificate instead, so it is byte
#   identical across rebuilds and the grant survives updates.
#
#   Apple state this directly in TN3127 ("Inside Code Signing: Requirements"):
#   ad-hoc signed code "has a DR but it's tied to that specific version of the
#   code", so macOS "can't reliably track the identity of the code".
#
# Root + leaf share an Organization on purpose. codesign derives a non-Apple
# DR by walking up the chain while the O= matches and pinning what it stops at,
# so the DR ends up pinned to the ROOT. That means the leaf can be reissued when
# it expires without changing the DR -- i.e. without users losing permissions.
#
# End users never need this certificate. Signature checking uses implicit
# anchors, so the embedded self-signed root validates on a Mac that has never
# seen it. Only the build machine needs to trust it, and only so that
# `security find-identity -v` lists the identity.
#
# Usage: tools/gen-signing-cert.sh [output-dir]
set -euo pipefail

OUT="${1:-$PWD/signing}"
ORG="Stoat Fork (ADCDS)"
ROOT_CN="Stoat Fork Signing Root"
# must match LEAF_CN in .github/workflows/release-artifacts.yml
LEAF_CN="Stoat Fork Code Signing"

umask 077
mkdir -p "$OUT"
cd "$OUT"

echo "==> root CA"
openssl genrsa -out root.key 4096 2>/dev/null
openssl req -x509 -new -key root.key -sha256 -days 7300 \
  -subj "/O=$ORG/CN=$ROOT_CN" \
  -addext "basicConstraints=critical,CA:true,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "subjectKeyIdentifier=hash" \
  -out root.crt

echo "==> leaf"
openssl genrsa -out leaf.key 3072 2>/dev/null
openssl req -new -key leaf.key -subj "/O=$ORG/CN=$LEAF_CN" -out leaf.csr

# extendedKeyUsage=codeSigning is mandatory: without it macOS treats the cert
# as "missing required extension" and find-identity will not list it.
cat > leaf.ext <<'EOF'
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF

openssl x509 -req -in leaf.csr -CA root.crt -CAkey root.key -CAcreateserial \
  -sha256 -days 7300 -extfile leaf.ext -out leaf.crt 2>/dev/null

echo "==> pkcs12 bundle"
P12_PASS="$(openssl rand -base64 32)"
# -legacy / SHA1-3DES on purpose. OpenSSL 3 defaults to AES-256-CBC + PBKDF2,
# which macOS `security import` either rejects outright ("MAC verification
# failed") or imports as an empty keychain entry.
openssl pkcs12 -export -legacy \
  -inkey leaf.key -in leaf.crt -certfile root.crt \
  -name "$LEAF_CN" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
  -passout "pass:$P12_PASS" \
  -out signing.p12 2>/dev/null

echo "==> sanity checks"
openssl verify -CAfile root.crt leaf.crt
openssl x509 -in leaf.crt -noout -text | grep -A1 'Extended Key Usage'
openssl pkcs12 -info -in signing.p12 -nokeys -passin "pass:$P12_PASS" \
  -legacy 2>&1 >/dev/null | grep -i 'algorithm' || true

cat <<EOF

================================================================
Generated in: $OUT
  root.key / root.crt   the trust anchor. The DR pins this, so keep
                        it -- losing it means every user re-grants.
  leaf.key / leaf.crt    the signing identity, reissuable under the root
  signing.p12            what CI imports

Set the repo secrets:

  base64 -w0 $OUT/signing.p12 | gh secret set MACOS_CERT_P12_BASE64 --repo ADCDS/for-desktop
  gh secret set MACOS_CERT_PASSWORD --repo ADCDS/for-desktop --body '$P12_PASS'

Store root.key, leaf.key and the password in a password manager. They are
gitignored, but anything signed with them inherits users' Accessibility and
Input Monitoring grants -- treat the key as sensitive.
================================================================
EOF
