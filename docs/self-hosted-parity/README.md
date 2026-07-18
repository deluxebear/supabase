# Self-hosted parity and Fleet Studio architecture

This directory contains the architecture and implementation records for the self-hosted Studio fork.

## Start here

- [Dual-profile Studio platform architecture and development standard](./2026-07-15-dual-profile-studio-platform-architecture.md): the engineering-reviewed normative baseline for Embedded Studio, Fleet Studio, Fleet Control, Backup Operator/Agent boundaries, development rules, testing, upstream synchronization, and release gates.
- [Current customization inventory and product alignment matrix](./2026-07-16-current-feature-inventory-and-alignment-matrix.md): current Upstream/Cloud/Fleet contract matrix, implemented customization inventory, stabilization closures, release gates, remaining boundaries, and Control Plane/Agent decision.
- [Fleet Studio cloud-parity QA report (2026-07-18)](./2026-07-18-fleet-studio-cloud-parity-qa-report.md): full browser + data-plane QA against the local Fleet control plane and two managed projects; includes route crawl, evidence screenshots, defects, and parity checklist.
- [Fleet upgrade, migration, failure, and rollback runbook](./2026-07-16-fleet-upgrade-migration-failure-rollback-runbook.md): release evidence, upgrade order, migration failure behavior, degradation matrix, rollback rules, and acceptance commands.
- [Compact control plane and unified Agent execution plan](./2026-07-16-compact-control-plane-unified-agent-execution-plan.md): deferred T12 packaging option for one Compact control process and one Agent process while preserving Fleet/Backup API, authorization, store, migration, and recovery boundaries; it is not a functional-completeness prerequisite.

## Core platform foundations

- [Multi-user and multi-project design](./2026-07-02-F9-F16-multiuser-multiproject-design.md)
- [Project registry and connection resolver](./2026-07-02-F9-F16-M2-project-registry-design.md)
- [Per-ref hardening](./2026-07-03-F9-F16-M2.1-per-ref-hardening-design.md)
- [Credential closure](./2026-07-03-F9-F16-M2.2-credential-closure-design.md)
- [RBAC core](./2026-07-03-F9-F16-M3.0-rbac-core-design.md)
- [Member management](./2026-07-03-F9-F16-M3.1-member-mgmt-design.md)
- [Invitations](./2026-07-04-F9-F16-M3.2-invitations-design.md)
- [Auth desired-state configuration](./2026-07-04-F9-F16-M4-auth-config-design.md)
- [Self-platform all-in-one Compose](./2026-07-10-self-platform-compose-design.md)

## Connectivity and observability

- [Health probing](./2026-07-05-M6.0-health-probing-design.md)
- [Connection configuration](./2026-07-05-M6.1-connection-config-design.md)
- [Logflare pipeline](./2026-07-06-M6.2-logflare-pipeline-design.md)
- [Infrastructure metrics](./2026-07-06-M6.3-infra-metrics-design.md)
- [Container-granular metrics](./2026-07-06-M6.4-container-granularity-metrics-design.md)
- [Kubernetes metrics identity](./2026-07-08-M6.4-D3-k8s-metrics-dialect-design.md)

## Backup and recovery

- [P1-5 backup and PITR operations](./2026-07-17-p1-5-backup-pitr-operations.md)
- [Go Backup Operator architecture](./2026-07-12-go-backup-operator-architecture.md)
- [Backup Operator runbook](./2026-07-07-F4-backups-operator-runbook.md)
- [Control-store recovery-domain spike](./2026-07-12-M0.1-control-store-recovery-domain-spike.md)
- [Patroni PITR spike](./2026-07-12-M0.2-patroni-pitr-spike.md)
- [Kubernetes replacement-workload spike](./2026-07-12-M0.3-kubernetes-replacement-spike.md)
- [Write-fence and provider contracts](./2026-07-12-M0.4-write-fence-and-provider-contracts.md)
- [Single-primary recovery](./2026-07-12-M3-single-primary-recovery.md)
- [Patroni recovery](./2026-07-12-M4-patroni-recovery.md)
- [Kubernetes replacement recovery](./2026-07-12-M5-kubernetes-replacement.md)

## Edge Functions

- [P1-6 Edge Functions operations](./2026-07-17-p1-6-edge-functions-operations.md)
- [T9 Edge Functions Fleet deployment operations](./2026-07-15-t9-edge-functions-fleet-deployment-operations.md)

## Document status

Older milestone documents remain useful implementation evidence. When they conflict with the dual-profile architecture baseline, the newer baseline governs unless a later ADR explicitly supersedes it.
