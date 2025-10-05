package main

import (
	"encoding/json"
	"log"
	"net/http"
)

type DeviceManifest struct {
	DeviceID        string `json:"device_id"`
	FirmwareVersion string `json:"firmware_version"`
	ContentVersion  string `json:"content_version"`
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	mux.HandleFunc("/iot/manifest", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", "\"demo-iot-etag\"")
		json.NewEncoder(w).Encode(DeviceManifest{
			DeviceID:        "demo-device",
			FirmwareVersion: "0.0.1",
			ContentVersion:  "0.0.1",
		})
	})

	mux.HandleFunc("/iot/telemetry", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	})

	addr := ":8082"
	log.Printf("ota-service listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

