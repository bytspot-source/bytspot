package middleware

import (
	"encoding/json"
	"net/http"
	"time"

	"bytspot/shared/models"
	"github.com/go-chi/chi/v5/middleware"
)

// HealthzHandler returns a standard health check handler
func HealthzHandler(serviceName, version string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		health := models.HealthStatus{
			Status:    "ok",
			Timestamp: time.Now().UTC(),
			Version:   version,
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(health)
	}
}

// ReadyzHandler returns a readiness check handler
func ReadyzHandler(serviceName, version string, checks map[string]func() error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := "ready"
		statusCode := http.StatusOK
		checkResults := make(map[string]string)

		// Run all health checks
		for name, check := range checks {
			if err := check(); err != nil {
				status = "not ready"
				statusCode = http.StatusServiceUnavailable
				checkResults[name] = err.Error()
			} else {
				checkResults[name] = "ok"
			}
		}

		health := models.HealthStatus{
			Status:    status,
			Timestamp: time.Now().UTC(),
			Version:   version,
			Checks:    checkResults,
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(statusCode)
		json.NewEncoder(w).Encode(health)
	}
}

// ErrorHandler returns a standard error response
func ErrorHandler(w http.ResponseWriter, statusCode int, err string, code string) {
	response := models.ErrorResponse{
		Error: err,
		Code:  code,
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(response)
}

// StandardMiddleware returns common middleware stack
func StandardMiddleware() []func(http.Handler) http.Handler {
	return []func(http.Handler) http.Handler{
		middleware.RequestID,
		middleware.RealIP,
		middleware.Logger,
		middleware.Recoverer,
		middleware.Timeout(30 * time.Second),
	}
}
