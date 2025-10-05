package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"
)

type Manifest struct {
	ModelName     string    `json:"model_name"`
	Version       string    `json:"version"`
	MinAppVersion string    `json:"min_app_version"`
	URLs          struct {
		Full      string `json:"full"`
		DeltaFrom string `json:"delta_from,omitempty"`
		DeltaURL  string `json:"delta_url,omitempty"`
	} `json:"urls"`
	SHA256      string    `json:"sha256"`
	Size        int64     `json:"size"`
	Rollout     string    `json:"rollout_phase"`
	KillSwitch  bool      `json:"kill_switch,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	ETag        string    `json:"etag,omitempty"`
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	mux.HandleFunc("/ml/model/concierge/manifest", func(w http.ResponseWriter, r *http.Request) {
		// TODO: validate JWT, cohort, platform/arch/app_version, compute ETag, check If-None-Match
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", "\"demo-etag\"")
		manifest := Manifest{
			ModelName:     "concierge",
			Version:       "0.1.0",
			MinAppVersion: "0.1.0",
			SHA256:        "0000000000000000000000000000000000000000000000000000000000000000",
			Size:          1,
			Rollout:       "canary",
			CreatedAt:     time.Now().UTC(),
			ETag:          "\"demo-etag\"",
		}
		manifest.URLs.Full = "https://example.invalid/model.onnx"
		json.NewEncoder(w).Encode(manifest)
	})

	mux.HandleFunc("/ml/metrics", func(w http.ResponseWriter, r *http.Request) {
		// TODO: read JSON, validate schema, enqueue to Kafka
		w.WriteHeader(http.StatusAccepted)
	})

	addr := ":8081"
	log.Printf("model-orchestrator listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

