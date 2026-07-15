#!/usr/bin/env bash
set -Eeuo pipefail

directory="${1:?release candidate directory is required}"
(cd "$directory" && sha256sum --check SHA256SUMS && sha256sum --check OCI_SHA256SUM)
for arch in amd64 arm64; do
  cmp "$directory/backup-operator-linux-$arch" "$directory/backup-agent-linux-$arch"
done
jq -e '.spdxVersion=="SPDX-2.3" and (.packages|length)>0' "$directory/sbom.spdx.json" >/dev/null
jq -e '.bomFormat=="CycloneDX" and .specVersion=="1.5" and (.components|length)>0' "$directory/sbom.cyclonedx.json" >/dev/null
jq -e '._type=="https://in-toto.io/Statement/v1" and .predicateType=="https://slsa.dev/provenance/v1" and (.subject|length)>=8' "$directory/provenance.intoto.jsonl" >/dev/null
while IFS=$'\t' read -r name digest; do
  actual="$(sha256sum "$directory/$name" | awk '{print $1}')"
  [ "$actual" = "$digest" ]
done < <(jq -r '.subject[]|[.name,.digest.sha256]|@tsv' "$directory/provenance.intoto.jsonl")
python3 - "$directory/backup-operator-multiarch.oci.tar" <<'PY'
import json, sys, tarfile
architectures=set()
with tarfile.open(sys.argv[1]) as archive:
    index=json.load(archive.extractfile("index.json"))
    for descriptor in index.get("manifests", []):
        arch=descriptor.get("platform", {}).get("architecture")
        if arch:
            architectures.add(arch)
    for member in archive.getmembers():
        if not member.isfile() or not member.name.startswith("blobs/sha256/"):
            continue
        try:
            value=json.load(archive.extractfile(member))
        except Exception:
            continue
        for descriptor in value.get("manifests", []):
            arch=descriptor.get("platform", {}).get("architecture")
            if arch:
                architectures.add(arch)
if not {"amd64", "arm64"}.issubset(architectures):
    raise SystemExit(f"multiarch OCI index missing platforms: {architectures}")
PY
jq -e '[.matrix[].result]|all(.=="passed" or .=="blocked-as-designed")' "$directory/upgrade-compatibility.json" >/dev/null
jq -e '.schema=="supabase.fleet.lifecycle.compatibility.v1" and .contractVersion=="v1" and (.providers.compose|index("postgres.upgrade.execute")|not) and (.providers.kubernetes|index("postgres.upgrade.execute"))' "$directory/lifecycle-compatibility-v1.json" >/dev/null
printf 'release_candidate_verification=PASS\n'
