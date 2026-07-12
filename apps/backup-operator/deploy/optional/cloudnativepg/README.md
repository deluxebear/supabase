# Optional CloudNativePG/CNPG-I provider

This directory documents the optional CloudNativePG adapter. It is not part of
the default customized Supabase PostgreSQL deployment and does not install
CloudNativePG, cert-manager, or the Barman Cloud plugin.

## Tested compatibility

- CloudNativePG: `1.29.1`
- Barman Cloud CNPG-I plugin: `0.13.0`
- CloudNativePG minimum accepted by the adapter: `1.26.0`
- Plugin name: `barman-cloud.cloudnative-pg.io`

Install and upgrade the optional dependencies independently using their
official manifests and procedures. The adapter stays disabled unless all of
the following are observed:

1. the workload is a `postgresql.cnpg.io/v1` `Cluster` positively owned by
   CloudNativePG;
2. CloudNativePG, cert-manager, and the Barman plugin report ready;
3. the source `ObjectStore`, source `serverName`, Cluster identity, primary,
   instance count, and every ready instance are observable;
4. the source database image has been validated with the selected CNPG version.

Recovery always creates a new CloudNativePG `Cluster`, which causes the
operator to allocate a new PVC set. The generated manifest uses
`spec.bootstrap.recovery`, an `externalClusters[].plugin` source, and a
different output ObjectStore/serverName for the recovered cluster. The Backup
Operator never patches or mounts the source Cluster's PVCs.

Official references:

- <https://cloudnative-pg.io/documentation/current/recovery/>
- <https://cloudnative-pg.io/plugin-barman-cloud/docs/usage/>
- <https://cloudnative-pg.io/plugin-barman-cloud/docs/installation/>
