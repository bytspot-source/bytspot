package server

import (
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"math/big"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"bytspot/shared/middleware"
)

var e164 = regexp.MustCompile(`^\+?[1-9]\d{7,14}$`)

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func randomCode(n int) (string, error) {
	digits := "0123456789"
	out := make([]byte, n)
	for i := 0; i < n; i++ {
		v, err := crand.Int(crand.Reader, big.NewInt(10))
		if err != nil {
			return "", err
		}
		out[i] = digits[v.Int64()]
	}
	return string(out), nil
}

func (s *ServerImpl) PostAuthPhoneStart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Phone   string  `json:"phone"`
		Channel *string `json:"channel"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !e164.MatchString(req.Phone) {
		middleware.ErrorHandler(w, http.StatusBadRequest, "invalid phone", "VALIDATION_ERROR")
		return
	}
	// Generate OTP code and hash
	code, err := randomCode(6)
	if err != nil {
		middleware.ErrorHandler(w, http.StatusInternalServerError, "otp error", "INTERNAL_ERROR")
		return
	}
	salt := os.Getenv("PHONE_HASH_SALT")
	codeHash := sha256Hex(salt + strings.ToLower(code+"|"+req.Phone))
	ttl := 5 * time.Minute
	if s.store == nil || s.store.Pool == nil {
		middleware.ErrorHandler(w, http.StatusInternalServerError, "store not ready", "INTERNAL_ERROR")
		return
	}
	if err := s.store.UpsertPhoneOTP(r.Context(), req.Phone, codeHash, ttl); err != nil {
		middleware.ErrorHandler(w, http.StatusInternalServerError, "db error", "INTERNAL_ERROR")
		return
	}
	// Dev provider: log code (replace with Twilio)
	log.Printf("OTP for %s: %s", req.Phone, code)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"status": "sent", "ttlSec": int(ttl.Seconds())})
}

func (s *ServerImpl) PostAuthPhoneVerify(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Phone string `json:"phone"`
		Code  string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !e164.MatchString(req.Phone) || len(req.Code) != 6 {
		middleware.ErrorHandler(w, http.StatusBadRequest, "invalid payload", "VALIDATION_ERROR")
		return
	}
	if s.store == nil || s.store.Pool == nil {
		middleware.ErrorHandler(w, http.StatusInternalServerError, "store not ready", "INTERNAL_ERROR")
		return
	}
	otp, err := s.store.GetPhoneOTP(r.Context(), req.Phone)
	if err != nil || otp == nil || time.Now().After(otp.ExpiresAt) {
		middleware.ErrorHandler(w, http.StatusUnauthorized, "otp expired", "UNAUTHORIZED")
		return
	}
	// Too many attempts -> lock until expiry
	maxAttempts := 5
	if otp.Attempts >= maxAttempts {
		middleware.ErrorHandler(w, http.StatusTooManyRequests, "too many attempts, try later", "RATE_LIMITED")
		return
	}
	// Verify code
	salt := os.Getenv("PHONE_HASH_SALT")
	expected := sha256Hex(salt + strings.ToLower(req.Code+"|"+req.Phone))
	if expected != otp.CodeHash {
		_ = s.store.IncrementOTPAttempts(r.Context(), otp.ID)
		middleware.ErrorHandler(w, http.StatusUnauthorized, "invalid code", "UNAUTHORIZED")
		return
	}
	_ = s.store.DeletePhoneOTP(r.Context(), otp.ID)
	// Create or fetch user by phone
	user, err := s.store.GetUserByPhone(r.Context(), req.Phone)
	if err != nil {
		middleware.ErrorHandler(w, http.StatusInternalServerError, "db error", "INTERNAL_ERROR")
		return
	}
	if user == nil {
		user, err = s.store.CreateUserPhoneOnly(r.Context(), req.Phone)
		if err != nil {
			middleware.ErrorHandler(w, http.StatusInternalServerError, "db error", "INTERNAL_ERROR")
			return
		}
		// set phone_hash for contacts match (unsalted hash of normalized phone)
		ph := sha256Hex(strings.ToLower(req.Phone))
		_, _ = s.store.Pool.Exec(r.Context(), `UPDATE users SET phone_hash=$1 WHERE id=$2`, ph, user.ID)
	}
	// Issue token
	token, exp, _ := signToken(user.ID, append(user.Roles, "user"), 15*time.Minute)
	resp := map[string]any{"access_token": token, "token_type": "Bearer", "expires_in": exp - time.Now().Unix(), "user": map[string]any{"id": user.ID, "phone": req.Phone}}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
