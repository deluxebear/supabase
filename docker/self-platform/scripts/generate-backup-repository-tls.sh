#!/usr/bin/env bash
# Issues the backup repository's TLS certificate from the management CA.
# pgBackRest talks to S3 over HTTPS only, and Agents already trust this CA.
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
trust_dir="${1:-${script_dir}/../secrets/fleet-management}"
output_dir="${2:-${script_dir}/../secrets/backup-repository}"

[[ -f "${trust_dir}/ca.crt" && -f "${trust_dir}/ca.key" ]] || {
  echo "Management CA is missing in ${trust_dir}; run generate-management-trust.sh first" >&2
  exit 1
}
if [[ -e "${output_dir}/rustfs_key.pem" ]]; then
  echo "Backup repository TLS material already exists in ${output_dir}"
  exit 0
fi

mkdir -p "${output_dir}"
# The files are mounted one by one, so the directory can stay private.
chmod 0700 "${output_dir}"
umask 077
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
openssl ecparam -name prime256v1 -genkey -noout -out "${work}/key.pem"
openssl req -new -sha256 -key "${work}/key.pem" -subj "/CN=backup-repository" -out "${work}/csr.pem"
printf '%s\n' \
  'subjectAltName=DNS:backup-repository,DNS:localhost,IP:127.0.0.1' \
  'extendedKeyUsage=serverAuth' \
  'keyUsage=digitalSignature,keyEncipherment' >"${work}/ext.cnf"
openssl x509 -req -sha256 -in "${work}/csr.pem" -CA "${trust_dir}/ca.crt" -CAkey "${trust_dir}/ca.key" \
  -CAserial "${work}/ca.srl" -CAcreateserial -days 825 -extfile "${work}/ext.cnf" -out "${work}/cert.pem"
# RustFS reads these names from its TLS directory and runs as UID 10001.
install -m 0644 "${work}/cert.pem" "${output_dir}/rustfs_cert.pem"
install -m 0644 "${work}/key.pem" "${output_dir}/rustfs_key.pem"
echo "Generated backup repository TLS material in ${output_dir}"
