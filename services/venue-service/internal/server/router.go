package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"

	"bytspot/services/venue-service/internal/api"

	"github.com/go-chi/chi/v5"
)

type serverImpl struct{}

// In-memory vibe store for beta
var vibeStore = struct {
	items map[string][]map[string]any
}{items: map[string][]map[string]any{}}

func (s *serverImpl) GetHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}

func (s *serverImpl) GetReadyz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ready"))
}

func (s *serverImpl) GetVenuesDiscover(w http.ResponseWriter, r *http.Request, params api.GetVenuesDiscoverParams) {
	// Mock response for beta
	items := []map[string]any{
		{"id": "v1", "title": "Energetic Bar", "subtitle": "Downtown", "rating": 4.5, "distance": "0.5km", "price": "$$"},
		{"id": "v2", "title": "Chill Lounge", "subtitle": "Riverside", "rating": 4.2, "distance": "1.2km", "price": "$"},
	}
	resp := map[string]any{"items": items}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (s *serverImpl) GetVenuesId(w http.ResponseWriter, r *http.Request, id string) {
	// Mock response
	venue := map[string]any{"id": id, "title": "Venue", "subtitle": "Location", "rating": 4.4, "distance": "0.8km", "price": "$$$"}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(venue)
}

func (s *serverImpl) PostVenuesIdLike(w http.ResponseWriter, r *http.Request, id string) {
	// Mock like acceptance
	w.WriteHeader(http.StatusNoContent)
}

func (s *serverImpl) PostVenuesIdVibe(w http.ResponseWriter, r *http.Request, id string) {
	// Optional HMAC signature verification (beta): if env VIBE_HMAC_SECRET set, verify x-signature header
	secret := os.Getenv("VIBE_HMAC_SECRET")
	if secret != "" {
		var bodyBuf bytes.Buffer
		tee := io.TeeReader(r.Body, &bodyBuf)
		var raw map[string]any
		if err := json.NewDecoder(tee).Decode(&raw); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		b, _ := json.Marshal(raw)
		sum := sha256.Sum256(append([]byte(secret), b...))
		expected := hex.EncodeToString(sum[:])
		got := r.Header.Get("x-signature")
		if got == "" || got != expected {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		r.Body = io.NopCloser(&bodyBuf)
	}

	var req struct {
		VibeScore  float64        `json:"vibeScore"`
		Confidence float64        `json:"confidence"`
		Timestamp  string         `json:"timestamp"`
		Features   map[string]any `json:"features"`
		Meta       struct {
			IdempotencyKey string `json:"idempotency_key"`
		} `json:"meta"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	// Basic validation
	if req.VibeScore < 0 || req.VibeScore > 10 {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if vibeStore.items[id] == nil {
		vibeStore.items[id] = []map[string]any{}
	}
	// naive dedupe by idempotency key within this process
	if req.Meta.IdempotencyKey != "" {
		for _, v := range vibeStore.items[id] {
			if v["idempotency_key"] == req.Meta.IdempotencyKey {
				w.WriteHeader(http.StatusAccepted)
				return
			}
		}
	}
	vibeStore.items[id] = append(vibeStore.items[id], map[string]any{
		"vibeScore":       req.VibeScore,
		"confidence":      req.Confidence,
		"timestamp":       req.Timestamp,
		"idempotency_key": req.Meta.IdempotencyKey,
	})
	w.WriteHeader(http.StatusAccepted)
}

func (s *serverImpl) GetVenuesIdVibeAggregate(w http.ResponseWriter, r *http.Request, id string) {
	var avg float64
	var count int
	for _, v := range vibeStore.items[id] {
		if f, ok := v["vibeScore"].(float64); ok {
			avg += f
			count++
		}
	}
	if count > 0 {
		avg = avg / float64(count)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"id": id, "avg": avg, "count": count})
}

func NewRouter() http.Handler {
	r := chi.NewRouter()
	return api.HandlerFromMux(&serverImpl{}, r)
}
