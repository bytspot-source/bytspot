package models

import (
	"time"
)

// Common types shared across all services

// AnonUserID represents a hashed, anonymized user identifier
type AnonUserID string

// DeviceID represents a device identifier
type DeviceID string

// VenueID represents a venue identifier
type VenueID string

// Geohash represents a geospatial hash
type Geohash string

// Platform represents the device platform
type Platform string

const (
	PlatformIOS     Platform = "ios"
	PlatformAndroid Platform = "android"
)

// ConsentKeys represents user consent permissions
type ConsentKeys []string

// Common consent key constants
const (
	ConsentLocation    = "location"
	ConsentMotion      = "motion"
	ConsentMicrophone  = "microphone"
	ConsentVibe        = "vibe"
	ConsentConcierge   = "concierge"
)

// BaseEvent represents common fields for all events
type BaseEvent struct {
	EventID   string    `json:"event_id"`
	Timestamp time.Time `json:"timestamp"`
	Version   string    `json:"version"`
}

// ErrorResponse represents a standard error response
type ErrorResponse struct {
	Error   string `json:"error"`
	Code    string `json:"code,omitempty"`
	Details string `json:"details,omitempty"`
}

// HealthStatus represents service health
type HealthStatus struct {
	Status    string            `json:"status"`
	Timestamp time.Time         `json:"timestamp"`
	Version   string            `json:"version"`
	Checks    map[string]string `json:"checks,omitempty"`
}
