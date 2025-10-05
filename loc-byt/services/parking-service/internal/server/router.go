package server

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
)

type serverImpl struct{}

type ParkingSearchParams struct {
	Lat   float64 `json:"lat"`
	Lon   float64 `json:"lon"`
	Radius int    `json:"radius"`
}

func (s *serverImpl) GetHealthz(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK); w.Write([]byte("ok")) }
func (s *serverImpl) GetReadyz(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK); w.Write([]byte("ready")) }

func (s *serverImpl) GetParkingSearch(w http.ResponseWriter, r *http.Request) {
	// Mock search result
	resp := map[string]any{"items": []map[string]any{
		{"id": "p1", "name": "Main Garage", "distance": "0.3km", "price": 8, "features": []string{"covered","ev"}},
	}}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (s *serverImpl) PostParkingReservations(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"status":"reserved", "id":"r1"})
}

func (s *serverImpl) GetParkingReservationsId(w http.ResponseWriter, r *http.Request, id string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"id": id, "status":"reserved"})
}

func (s *serverImpl) PatchParkingReservationsIdCheckin(w http.ResponseWriter, r *http.Request, id string) {
	w.WriteHeader(http.StatusNoContent)
}

func NewRouter() http.Handler {
	r := chi.NewRouter()
	r.Get("/healthz", (&serverImpl{}).GetHealthz)
	r.Get("/readyz", (&serverImpl{}).GetReadyz)
	r.Get("/parking/search", (&serverImpl{}).GetParkingSearch)
	r.Post("/parking/reservations", (&serverImpl{}).PostParkingReservations)
	r.Get("/parking/reservations/{id}", (&serverImpl{}).GetParkingReservationsId)
	r.Patch("/parking/reservations/{id}/checkin", (&serverImpl{}).PatchParkingReservationsIdCheckin)
	return r
}

