package server

import (
	"encoding/json"
	"net/http"

	"bytspot/services/valet-service/internal/store"

	"github.com/go-chi/chi/v5"
)

type serverImpl struct{ st *store.Store }

type intakeReq struct {
	UserID   string                `json:"userId"`
	Vehicle  store.Vehicle         `json:"vehicle"`
	Spot     string                `json:"spot"`
	Services []store.ServiceOption `json:"services"`
	Photos   []string              `json:"photos"`
}

type statusReq struct {
	Status store.TicketStatus `json:"status"`
}

// MVP endpoints for valet ops and tasks
func (s *serverImpl) GetHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}
func (s *serverImpl) GetReadyz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ready"))
}

// Pre-Arrival Notification: for now, mock a feed
func (s *serverImpl) GetValetTasks(w http.ResponseWriter, r *http.Request) {
	resp := map[string]any{"items": []map[string]any{
		{"id": "t1", "type": "dropoff", "user": "John", "eta": "2m", "status": "pending"},
	}}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// Intake: optional services, photos, vehicle info
func (s *serverImpl) PostValetIntake(w http.ResponseWriter, r *http.Request) {
	var req intakeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.UserID == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]any{"error": "invalid payload"})
		return
	}
	t := &store.Ticket{UserID: req.UserID, Vehicle: req.Vehicle, Spot: req.Spot, Services: req.Services, Photos: req.Photos, Status: store.StatusIntake}
	s.st.CreateTicket(t)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"status": "intake_started", "ticket": t.ID})
}

// Real-time status updates
func (s *serverImpl) PatchValetVehiclesIdStatus(w http.ResponseWriter, r *http.Request, id string) {
	var req statusReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Status == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if ok := s.st.UpdateStatus(id, req.Status); !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Retrieval request dispatch
func (s *serverImpl) PostValetRequests(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"status": "dispatched", "task": "rt1"})
}

func NewRouter() http.Handler {
	impl := &serverImpl{st: store.New()}
	r := chi.NewRouter()
	r.Get("/healthz", impl.GetHealthz)
	r.Get("/readyz", impl.GetReadyz)
	// core valet endpoints
	r.Get("/valet/tasks", impl.GetValetTasks)
	r.Post("/valet/intake", impl.PostValetIntake)
	r.Patch("/valet/vehicles/{id}/status", func(w http.ResponseWriter, r *http.Request) {
		impl.PatchValetVehiclesIdStatus(w, r, chi.URLParam(r, "id"))
	})
	r.Post("/valet/requests", impl.PostValetRequests)
	return r
}
