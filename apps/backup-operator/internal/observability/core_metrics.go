package observability

import "time"

// CoreMetrics is the low-cardinality instrumentation surface shared by the
// operator runtime and observation providers. Identifiers never become labels.
type CoreMetrics struct{ Registry *Metrics }

func (m CoreMetrics) add(name string, labels map[string]string) {
	if m.Registry != nil {
		_ = m.Registry.Add(name, 1, labels)
	}
}
func (m CoreMetrics) set(name string, value float64, labels map[string]string) {
	if m.Registry != nil {
		_ = m.Registry.Set(name, value, labels)
	}
}

func (m CoreMetrics) Job(operation, result string, duration time.Duration) {
	m.add("backup_operator_jobs_total", map[string]string{"operation": operation, "result": result})
	m.set("backup_operator_job_duration_seconds", duration.Seconds(), map[string]string{"operation": operation, "result": result})
}
func (m CoreMetrics) AgentSession(connected bool, lastSeen time.Time) {
	result, value := "disconnected", 0.0
	if connected {
		result, value = "connected", 1
	}
	m.set("backup_operator_agent_connected", value, map[string]string{"result": result})
	if !lastSeen.IsZero() {
		m.set("backup_operator_agent_last_seen_timestamp_seconds", float64(lastSeen.UTC().Unix()), nil)
	}
}
func (m CoreMetrics) Outbox(operation, result string, depth int) {
	m.add("backup_operator_outbox_operations_total", map[string]string{"operation": operation, "result": result})
	m.set("backup_operator_outbox_depth", float64(depth), nil)
}
func (m CoreMetrics) Orphans(count int) { m.set("backup_operator_orphan_tasks", float64(count), nil) }
func (m CoreMetrics) Repository(provider string, healthy bool) {
	result := "failed"
	if healthy {
		result = "success"
	}
	m.set("backup_operator_repository_check", 1, map[string]string{"provider": provider, "result": result})
}
func (m CoreMetrics) WAL(gap bool) {
	result := "continuous"
	if gap {
		result = "gap"
	}
	m.set("backup_operator_wal_continuity", 1, map[string]string{"result": result})
}
func (m CoreMetrics) RecoveryWindow(seconds float64) {
	m.set("backup_operator_recovery_window_seconds", seconds, nil)
}
func (m CoreMetrics) Quarantine(operation, result string, count int) {
	m.add("backup_operator_quarantine_operations_total", map[string]string{"operation": operation, "result": result})
	m.set("backup_operator_quarantine_resources", float64(count), nil)
}
