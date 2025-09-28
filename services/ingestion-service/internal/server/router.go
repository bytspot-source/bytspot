package server

import (
	"encoding/json"
	"log"
	"net/http"

	"bytspot/services/ingestion-service/internal/api"
	"bytspot/shared/middleware"
	"bytspot/shared/models"
	"github.com/go-chi/chi/v5"
)

const (
	serviceName = "ingestion-service"
	version     = "0.1.0"
)

// serverImpl implements the generated ServerInterface
type serverImpl struct{}

// GetHealthz implements the health check endpoint
func (s *serverImpl) GetHealthz(w http.ResponseWriter, r *http.Request) {
	middleware.HealthzHandler(serviceName, version)(w, r)
}

// GetReadyz implements the readiness check endpoint
func (s *serverImpl) GetReadyz(w http.ResponseWriter, r *http.Request) {
	// Define readiness checks
	checks := map[string]func() error{
		"service": func() error { return nil }, // Add real checks here
	}
	middleware.ReadyzHandler(serviceName, version, checks)(w, r)
}

// PostIngestBatch implements the batch ingestion endpoint
func (s *serverImpl) PostIngestBatch(w http.ResponseWriter, r *http.Request) {
	// TODO: Add request validation, PII hashing, and Kafka producer
	log.Printf("POST /ingest/batch received")

	// Parse request body
	var batch api.DeviceBatch
	if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
		middleware.ErrorHandler(w, http.StatusBadRequest, "invalid JSON", "INVALID_JSON")
		return
	}

	log.Printf("Received batch with %d items", len(batch.Batches))

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]string{"status": "accepted"})
}

func NewRouter() http.Handler {
	r := chi.NewRouter()

	// Use standard middleware from shared package
	for _, mw := range middleware.StandardMiddleware() {
		r.Use(mw)
	}

	// Use the generated handler registration
	return api.HandlerFromMux(&serverImpl{}, r)
}

