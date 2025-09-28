package utils

import (
	"crypto/sha256"
	"fmt"
)

// HashUserID creates an anonymized user ID using SHA-256
// This implements the PII hashing strategy from the Mobile BMS design
func HashUserID(userID, salt, pepper string) string {
	combined := userID + salt + pepper
	hash := sha256.Sum256([]byte(combined))
	return fmt.Sprintf("%x", hash)
}

// ValidateGeohash performs basic geohash validation
func ValidateGeohash(geohash string) bool {
	if len(geohash) < 1 || len(geohash) > 12 {
		return false
	}
	// Basic character set validation for geohash
	validChars := "0123456789bcdefghjkmnpqrstuvwxyz"
	for _, char := range geohash {
		found := false
		for _, valid := range validChars {
			if char == valid {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
