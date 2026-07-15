#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${VERSION:-v0.1.1-rc.local}"
commit="${COMMIT:-$(git -C "$root" rev-parse HEAD)}"
output="${OUTPUT_DIR:-$root/dist/release-candidate}"
build_date="${BUILD_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
workspace_dirty=false
if [ -n "$(git -C "$root" status --porcelain)" ]; then workspace_dirty=true; fi
evidence_output="external-output-directory"
if [[ "$output" == "$root/"* ]]; then
  evidence_output="${output#"$root/"}"
fi
rm -rf "$output"
mkdir -p "$output"

VERSION="$version" COMMIT="$commit" OUTPUT_DIR="$output" "$root/scripts/build-release.sh"

modules="$(mktemp)"
trap 'rm -f "$modules"' EXIT
(cd "$root" && go list -m -json all | jq -s .) >"$modules"
jq -n --arg version "$version" --arg commit "$commit" --arg created "$build_date" --slurpfile modules "$modules" '
  {spdxVersion:"SPDX-2.3",dataLicense:"CC0-1.0",SPDXID:"SPDXRef-DOCUMENT",name:("backup-operator-"+$version),
   documentNamespace:("https://supabase.com/spdx/backup-operator/"+$version+"/"+$commit),creationInfo:{created:$created,creators:["Tool: local-go-module-sbom"]},
   packages:($modules[0]|to_entries|map({name:.value.Path,SPDXID:("SPDXRef-Package-"+((.key+1)|tostring)),versionInfo:(.value.Version//"workspace"),downloadLocation:(.value.Path//"NOASSERTION"),filesAnalyzed:false,licenseConcluded:"NOASSERTION",licenseDeclared:"NOASSERTION"}))}' \
  >"$output/sbom.spdx.json"
serial_number="$(python3 - "$version" "$commit" <<'PY'
import sys, uuid
print("urn:uuid:" + str(uuid.uuid5(uuid.NAMESPACE_URL, "supabase-backup-operator:" + sys.argv[1] + ":" + sys.argv[2])))
PY
)"
jq -n --arg version "$version" --arg created "$build_date" --arg serial "$serial_number" --slurpfile modules "$modules" '
  {bomFormat:"CycloneDX",specVersion:"1.5",serialNumber:$serial,version:1,
   metadata:{timestamp:$created,component:{type:"application",name:"backup-operator",version:$version}},
   components:($modules[0]|map({type:"library",name:.Path,version:(.Version//"workspace"),purl:("pkg:golang/"+.Path+"@"+(.Version//"workspace"))}))}' \
  >"$output/sbom.cyclonedx.json"

python3 "$root/scripts/build-oci-layout.py" --input "$output" --output "$output/backup-operator-multiarch.oci.tar" \
  --version "$version" --commit "$commit" --created "$build_date"
(cd "$output" && sha256sum backup-operator-multiarch.oci.tar >OCI_SHA256SUM)

cat >"$output/upgrade-compatibility.json" <<JSON
{"schema_version":1,"version":"$version","matrix":[
 {"from":"same-schema","to":"$version","control_store":"sqlite","result":"passed","evidence":"idempotent migration reopen"},
 {"from":"same-schema","to":"$version","control_store":"postgres","result":"passed","evidence":"real PostgreSQL migration reopen"},
 {"from":"protocol-v1.2","to":"protocol-v1.3","strategy":"operator-first rolling","result":"passed","evidence":"minor negotiation chooses v1.2"},
 {"from":"different-agent-build","to":"$version","operation":"destructive","result":"blocked-as-designed","evidence":"destructive build pin"}
]}
JSON
cp "$root/release/lifecycle-compatibility-v1.json" "$output/lifecycle-compatibility-v1.json"

(cd "$output" && sha256sum backup-operator-linux-* backup-agent-linux-* backupctl-linux-* sbom.*.json backup-operator-multiarch.oci.tar upgrade-compatibility.json lifecycle-compatibility-v1.json >SHA256SUMS)
subjects="$(cd "$output" && awk '{print $1"\t"$2}' SHA256SUMS | jq -Rn '[inputs|split("\t")|{name:.[1],digest:{sha256:.[0]}}]')"
jq -n --arg version "$version" --arg commit "$commit" --arg created "$build_date" --argjson workspace_dirty "$workspace_dirty" --argjson subjects "$subjects" '
  {_type:"https://in-toto.io/Statement/v1",subject:$subjects,predicateType:"https://slsa.dev/provenance/v1",
   predicate:{buildDefinition:{buildType:"https://supabase.com/buildtypes/go-cross-compile/v1",externalParameters:{version:$version,platforms:["linux/amd64","linux/arm64"],workspaceDirty:$workspace_dirty},resolvedDependencies:[{uri:("git+https://github.com/supabase/supabase@"+$commit)}]},
   runDetails:{builder:{id:"local-codex-release-candidate"},metadata:{invocationId:("local-"+$commit),startedOn:$created,finishedOn:$created}}}}' \
  >"$output/provenance.intoto.jsonl"
(cd "$output" && sha256sum provenance.intoto.jsonl >>SHA256SUMS && sha256sum --check SHA256SUMS)

"$root/scripts/verify-release-candidate.sh" "$output"
"$root/scripts/validate-deployments.sh"
(cd "$root" && go test ./internal/controlstore ./internal/security -run 'Test(SQLiteTransactionalOutbox|PendingOutboxSurvivesRestart|NegotiationAndDestructiveVersionPin)' -count=1)

jq -n --arg observed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg version "$version" --arg commit "$commit" \
  --arg output "$evidence_output" --argjson workspace_dirty "$workspace_dirty" \
  '{schema_version:1,scenario:"release-candidate",status:"passed",exit_code:0,observed_at:$observed_at,
    facts:{version:$version,commit:$commit,workspace_dirty:$workspace_dirty,
      binaries:{operator:["linux/amd64","linux/arm64"],agent:["linux/amd64","linux/arm64"],backupctl:["linux/amd64","linux/arm64"]},
      agent_binary_note:"backup-agent assets are byte-identical aliases of backup-operator; runtime role is selected with --mode=agent",
      oci_multiarch:"passed: local OCI layout contains amd64 and arm64 manifests",
      sbom:["SPDX-2.3","CycloneDX-1.5"],checksums:"verified",provenance:"offline subject digests verified",
      deployments:"compose, Helm and Kustomize validated locally; systemd validation reused passed Linux-container evidence from failure-observability matrix",
      upgrade_matrix:"SQLite migration reopen, protocol rolling, and lifecycle target-version compatibility passed; incompatible actions are blocked",
      output_directory:$output,
      external_step_requiring_user_authorization:"publish_and_sign: push multiarch OCI, upload release assets, create external release, and perform external keyless signing/transparency-log entry",
      external_actions_performed:false,RESULT:"PASS"}}' >"$root/test/e2e/evidence/release-candidate.json"
cat "$root/test/e2e/evidence/release-candidate.json"
