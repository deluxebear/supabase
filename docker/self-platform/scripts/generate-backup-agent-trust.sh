#!/usr/bin/env bash
# Creates the CA that signs backup Agent client certificates and the Backup
# Operator's gRPC server certificate. It is separate from the Fleet Agent CA,
# so a Fleet Agent certificate cannot authenticate to the Backup Operator.
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output_dir="${1:-${script_dir}/../secrets/backup-operator}"
tls_dir="${output_dir}/tls"

if [[ -e "${tls_dir}/ca.key" ]]; then
  echo "Backup Agent trust material already exists in ${tls_dir}"
  exit 0
fi

mkdir -p "${tls_dir}" "${output_dir}/clusters"
chmod 0700 "${output_dir}" "${tls_dir}" "${output_dir}/clusters"
umask 077
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
openssl ecparam -name prime256v1 -genkey -noout -out "${tls_dir}/ca.key"
openssl req -x509 -new -sha256 -key "${tls_dir}/ca.key" -days 3650 \
  -subj "/CN=Supabase Backup Agent CA" -out "${tls_dir}/ca.crt"
openssl ecparam -name prime256v1 -genkey -noout -out "${tls_dir}/server.key"
openssl req -new -sha256 -key "${tls_dir}/server.key" -subj "/CN=backup-operator" -out "${work}/server.csr"
printf '%s\n' \
  'subjectAltName=DNS:backup-operator' \
  'extendedKeyUsage=serverAuth' \
  'keyUsage=digitalSignature,keyEncipherment' >"${work}/server.ext"
openssl x509 -req -sha256 -in "${work}/server.csr" -CA "${tls_dir}/ca.crt" -CAkey "${tls_dir}/ca.key" \
  -CAserial "${work}/ca.srl" -CAcreateserial -days 825 -extfile "${work}/server.ext" -out "${tls_dir}/server.crt"
chmod 0600 "${tls_dir}/ca.key" "${tls_dir}/server.key"
chmod 0644 "${tls_dir}/ca.crt" "${tls_dir}/server.crt"
echo "Generated backup Agent trust material in ${tls_dir}"
