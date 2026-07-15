#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")/.."

go test ./internal/fleetcontrol -run 'Test(SessionLimiterMeetsThreeHundredAgentEnvelope|TwentyConcurrentTargetOperationsMeetAndStopAtEnvelope|HundredProjectControlReadsMeetLatencyAndEventVisibilityEnvelope|OperationQuotasAndConcurrencyAreProjectTargetAndOrganizationScoped|RetentionCapsActiveOperationEventsAndArchivesAudit)$' -count=1
go test ./internal/fleetagent -run 'TestReconnectDelay' -count=1
go test ./internal/app -run 'Test(InProcessTransportBoundsConcurrentBackupOperations|PeriodicWorkerContinuesAfterTransientCycleFailure)$' -count=1

printf 'RESULT=PASS projects=100 agent_sessions=300 concurrent_operations=20 live_events_per_operation=10000 event_visibility_slo=5s\n'
