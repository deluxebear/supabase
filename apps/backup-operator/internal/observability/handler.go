package observability

import "net/http"

func MetricsHandler(metrics *Metrics) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		if metrics == nil {
			http.Error(w, "metrics registry is unavailable", http.StatusServiceUnavailable)
			return
		}
		if err := metrics.WritePrometheus(w); err != nil {
			http.Error(w, "metrics exposition failed", http.StatusInternalServerError)
		}
	})
}
