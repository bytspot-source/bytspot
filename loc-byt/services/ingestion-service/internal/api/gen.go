// This file will be replaced by oapi-codegen output when running `make generate-api`
// The structure below matches what oapi-codegen will generate for our OpenAPI spec
package api

import (
	"encoding/json"
	"net/http"
	"time"
)

// Types generated from OpenAPI schema components
type DeviceBatch struct {
	Batches []BatchItem `json:"batches"`
}

type BatchItem struct {
	BatchID        string                 `json:"batch_id"`
	AnonUserID     string                 `json:"anon_user_id"`
	DeviceTsStart  time.Time              `json:"device_ts_start"`
	DeviceTsEnd    time.Time              `json:"device_ts_end"`
	Geohash7       string                 `json:"geohash7"`
	MotionStats    *MotionStats           `json:"motion_stats,omitempty"`
	AudioFeatures  *AudioFeatures         `json:"audio_features,omitempty"`
	TriageState    *TriageState           `json:"triage_state,omitempty"`
	DeviceMetrics  *DeviceMetrics         `json:"device_metrics,omitempty"`
	ConsentKeys    *[]string              `json:"consent_keys,omitempty"`
	AppVersion     *string                `json:"app_version,omitempty"`
	Platform       *string                `json:"platform,omitempty"`
}

type MotionStats struct {
	Steps           *int     `json:"steps,omitempty"`
	Variance        *float64 `json:"variance,omitempty"`
	StationaryRatio *float64 `json:"stationary_ratio,omitempty"`
}

type AudioFeatures struct {
	MfccHist     *[]float64 `json:"mfcc_hist,omitempty"`
	LoudnessBins *[]float64 `json:"loudness_bins,omitempty"`
	SnrBucket    *int       `json:"snr_bucket,omitempty"`
}

type TriageState struct {
	FsmPath           *string `json:"fsm_path,omitempty"`
	ActiveSeconds     *int    `json:"active_seconds,omitempty"`
	SamplingProfileID *string `json:"sampling_profile_id,omitempty"`
}

type DeviceMetrics struct {
	BatteryLevel  *int `json:"battery_level,omitempty"`
	RadioWakeups  *int `json:"radio_wakeups,omitempty"`
}

// ServerInterface represents all server handlers.
type ServerInterface interface {
	// Health check endpoints
	GetHealthz(w http.ResponseWriter, r *http.Request)
	GetReadyz(w http.ResponseWriter, r *http.Request)
	// Ingest batched device features and metrics
	PostIngestBatch(w http.ResponseWriter, r *http.Request)
}

// HandlerFromMux creates http.Handler with routing attached to the given mux.
func HandlerFromMux(si ServerInterface, r chi.Router) http.Handler {
	return HandlerFromMuxWithBaseURL(si, r, "")
}

// HandlerFromMuxWithBaseURL creates http.Handler with routing attached to the given mux.
func HandlerFromMuxWithBaseURL(si ServerInterface, r chi.Router, baseURL string) http.Handler {
	r.Get(baseURL+"/healthz", si.GetHealthz)
	r.Get(baseURL+"/readyz", si.GetReadyz)
	r.Post(baseURL+"/ingest/batch", si.PostIngestBatch)
	return r
}

// Placeholder chi interface to avoid import cycle
type chi interface {
	Get(pattern string, handlerFn http.HandlerFunc)
	Post(pattern string, handlerFn http.HandlerFunc)
}

type Router interface {
	chi
}

