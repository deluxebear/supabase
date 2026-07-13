#!/usr/bin/env python3
import argparse, gzip, hashlib, io, json, os, pathlib, tarfile, tempfile

p = argparse.ArgumentParser()
p.add_argument("--input", required=True)
p.add_argument("--output", required=True)
p.add_argument("--version", required=True)
p.add_argument("--commit", required=True)
p.add_argument("--created", required=True)
a = p.parse_args()

def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
def blob(root, payload):
    digest = hashlib.sha256(payload).hexdigest()
    (root / "blobs" / "sha256" / digest).write_bytes(payload)
    return {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": "sha256:"+digest, "size": len(payload)}
def layer_payload(source):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as tar:
        for name, path in (("usr/local/bin/backup-operator", source[0]), ("usr/local/bin/backupctl", source[1])):
            data = pathlib.Path(path).read_bytes()
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime, info.uid, info.gid = len(data), 0o755, 0, 65532, 65532
            tar.addfile(info, io.BytesIO(data))
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", mtime=0) as zipped:
        zipped.write(raw.getvalue())
    return output.getvalue(), "sha256:"+hashlib.sha256(raw.getvalue()).hexdigest()

with tempfile.TemporaryDirectory() as temp:
    root = pathlib.Path(temp)
    (root / "blobs" / "sha256").mkdir(parents=True)
    (root / "oci-layout").write_text('{"imageLayoutVersion":"1.0.0"}\n')
    manifests=[]
    for arch in ("amd64", "arm64"):
        layer, diff_id = layer_payload((f"{a.input}/backup-operator-linux-{arch}", f"{a.input}/backupctl-linux-{arch}"))
        layer_desc = blob(root, layer)
        layer_desc["mediaType"] = "application/vnd.oci.image.layer.v1.tar+gzip"
        config = encoded({"created":a.created,"architecture":arch,"os":"linux","config":{"User":"65532:65532","Entrypoint":["/usr/local/bin/backup-operator"],"Labels":{"org.opencontainers.image.version":a.version,"org.opencontainers.image.revision":a.commit}},"rootfs":{"type":"layers","diff_ids":[diff_id]}})
        config_desc = blob(root, config)
        manifest = encoded({"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":config_desc,"layers":[layer_desc]})
        manifest_desc = blob(root, manifest)
        manifest_desc["mediaType"] = "application/vnd.oci.image.manifest.v1+json"
        manifest_desc["platform"] = {"architecture":arch,"os":"linux"}
        manifests.append(manifest_desc)
    (root / "index.json").write_bytes(encoded({"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":manifests}))
    with tarfile.open(a.output, "w") as archive:
        for path in sorted(root.rglob("*")):
            archive.add(path, arcname=str(path.relative_to(root)), recursive=False)
