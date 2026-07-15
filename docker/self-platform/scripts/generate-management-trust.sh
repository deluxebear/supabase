#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output_dir="${1:-${script_dir}/../secrets/fleet-management}"

if [[ -e "${output_dir}/ca.key" || -e "${output_dir}/server.key" ]]; then
  echo "Refusing to replace existing management trust material in ${output_dir}" >&2
  exit 1
fi

mkdir -p "${output_dir}"
umask 077
openssl ecparam -name prime256v1 -genkey -noout -out "${output_dir}/ca.key"
openssl req -x509 -new -sha256 -key "${output_dir}/ca.key" -days 3650 \
  -subj "/CN=Supabase Fleet Agent CA" -out "${output_dir}/ca.crt"
openssl ecparam -name prime256v1 -genkey -noout -out "${output_dir}/server.key"
openssl req -new -sha256 -key "${output_dir}/server.key" -subj "/CN=fleet-control" \
  -out "${output_dir}/server.csr"
printf '%s\n' \
  'subjectAltName=DNS:fleet-control,DNS:backup-operator-tls,DNS:localhost,IP:127.0.0.1' \
  'extendedKeyUsage=serverAuth' \
  'keyUsage=digitalSignature,keyEncipherment' >"${output_dir}/server.ext"
openssl x509 -req -sha256 -in "${output_dir}/server.csr" \
  -CA "${output_dir}/ca.crt" -CAkey "${output_dir}/ca.key" -CAcreateserial \
  -days 825 -extfile "${output_dir}/server.ext" -out "${output_dir}/server.crt"
rm -f "${output_dir}/server.csr" "${output_dir}/server.ext" "${output_dir}/ca.srl"
chmod 600 "${output_dir}/ca.key" "${output_dir}/server.key"
chmod 644 "${output_dir}/ca.crt" "${output_dir}/server.crt"
echo "Generated management trust material in ${output_dir}"
