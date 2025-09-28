package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"bytspot/services/auth-service/internal/api"
	"bytspot/services/auth-service/internal/db"
	"bytspot/shared/middleware"

	"github.com/go-chi/chi/v5"
)

var allowedServiceTypes = map[string]bool{"venue": true, "parking": true, "valet": true}

type ServerImpl struct{ store *db.Store }

// ServerImpl exposes store for dev tools
func (s *ServerImpl) Store() *db.Store { return s.store }

func NewServerImpl(ctx context.Context) (*ServerImpl, error) {
	store, err := db.New(ctx)
	if err != nil {
		return nil, err
	}
	return &ServerImpl{store: store}, nil
}

// Health
func (s *ServerImpl) GetHealthz(w http.ResponseWriter, r *http.Request) {
	middleware.HealthzHandler("auth-service", "0.1.0")(w, r)
}

func (s *ServerImpl) GetReadyz(w http.ResponseWriter, r *http.Request) {
	checks := map[string]func() error{"service": func() error { return nil }}
	middleware.ReadyzHandler("auth-service", "0.1.0", checks)(w, r)
}

// Auth
func (s *ServerImpl) PostAuthRegister(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string  `json:"email"`
		Password string  `json:"password"`
		Name     *string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.ErrorHandler(w, http.StatusBadRequest, "invalid JSON", "INVALID_JSON")
		return
	}
	if req.Email == "" || req.Password == "" {
		middleware.ErrorHandler(w, http.StatusBadRequest, "email and password required", "VALIDATION_ERROR")
		return
	}
	// Hash password and insert user in DB
	hash, err := HashPassword(req.Password)
	if err != nil {
		middleware.ErrorHandler(w, http.StatusInternalServerError, "hashing failed", "INTERNAL_ERROR")
		return
	}
	u := &db.User{Email: req.Email, PasswordHash: hash, Name: req.Name, Provider: "local", Roles: []string{"user"}, TokenVersion: 1}
	if err := s.store.CreateUser(r.Context(), u); err != nil {
		if errors.Is(err, db.ErrDuplicateEmail) {
			middleware.ErrorHandler(w, http.StatusConflict, "email already exists", "EMAIL_EXISTS")
			return
		}
		middleware.ErrorHandler(w, http.StatusInternalServerError, "db error", "INTERNAL_ERROR")
		return
	}
	w.WriteHeader(http.StatusCreated)
}

func (s *ServerImpl) PostAuthLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		middleware.ErrorHandler(w, http.StatusBadRequest, "invalid JSON", "INVALID_JSON")
		return
	}
	// Verify against DB
	u, err := s.store.GetUserByEmail(r.Context(), req.Email)
	if err != nil {
		middleware.ErrorHandler(w, http.StatusInternalServerError, "db error", "INTERNAL_ERROR")
		return
	}
	if u == nil {
		middleware.ErrorHandler(w, http.StatusUnauthorized, "invalid credentials", "UNAUTHORIZED")
		return
	}
	ok, err := VerifyPassword(req.Password, u.PasswordHash)
	if err != nil || !ok {
		middleware.ErrorHandler(w, http.StatusUnauthorized, "invalid credentials", "UNAUTHORIZED")
		return
	}
	_ = s.store.UpdateLastLogin(r.Context(), u.ID, time.Now())
	// Issue JWT with subject=user id + roles
	token, exp, _ := signToken(u.ID, u.Roles, 15*time.Minute)
	resp := map[string]any{"access_token": token, "token_type": "Bearer", "expires_in": exp - time.Now().Unix(), "user": map[string]any{"id": u.ID, "email": u.Email, "name": u.Name, "roles": u.Roles}}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (s *ServerImpl) GetAuthMe(w http.ResponseWriter, r *http.Request) {
	authz := r.Header.Get("Authorization")
	if !strings.HasPrefix(authz, "Bearer ") {
		middleware.ErrorHandler(w, http.StatusUnauthorized, "missing token", "UNAUTHORIZED")
		return
	}
	tok := strings.TrimPrefix(authz, "Bearer ")
	claims, err := verifyToken(tok)
	if err != nil {
		middleware.ErrorHandler(w, http.StatusUnauthorized, "invalid token", "UNAUTHORIZED")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"user": map[string]any{"id": claims.Sub, "email": claims.Sub}})
}

func NewRouter() http.Handler {
	r := chi.NewRouter()
	for _, m := range middleware.StandardMiddleware() {
		r.Use(m)
	}

	// Initialize server with DB store
	impl, err := NewServerImpl(context.Background())
	if err != nil {
		// If store fails, we still return handler but endpoints using store will 500
		impl = &ServerImpl{}
	}

	// Register OpenAPI-driven routes with live impl
	h := api.HandlerFromMux(impl, r)

	// Non-spec admin management route (secured by admin role)
	r.Post("/auth/admin/promote", func(w http.ResponseWriter, r *http.Request) {
		// Require admin JWT
		authz := r.Header.Get("Authorization")
		if !strings.HasPrefix(authz, "Bearer ") {
			middleware.ErrorHandler(w, http.StatusUnauthorized, "missing token", "UNAUTHORIZED")
			return
		}
		claims, err := verifyToken(strings.TrimPrefix(authz, "Bearer "))
		if err != nil {
			middleware.ErrorHandler(w, http.StatusUnauthorized, "invalid token", "UNAUTHORIZED")
			return
		}
		isAdmin := false
		for _, role := range claims.Roles {
			if role == "admin" {
				isAdmin = true
				break
			}
		}
		if !isAdmin {
			middleware.ErrorHandler(w, http.StatusForbidden, "admin role required", "FORBIDDEN")
			return
		}
		var req struct {
			Email string `json:"email"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Email == "" {
			middleware.ErrorHandler(w, http.StatusBadRequest, "invalid JSON", "INVALID_JSON")
			return
		}
		if impl.store == nil || impl.store.Pool == nil {
			middleware.ErrorHandler(w, http.StatusInternalServerError, "store not ready", "INTERNAL_ERROR")
			return
		}
		if err := impl.store.PromoteAdminByEmail(r.Context(), req.Email); err != nil {
			middleware.ErrorHandler(w, http.StatusInternalServerError, "db error", "INTERNAL_ERROR")
			return
		}
		_ = impl.store.InsertAdminAudit(r.Context(), claims.Sub, req.Email, "promote", "")
		w.WriteHeader(http.StatusNoContent)
	})

	// Non-spec admin demote route (secured by admin role)
	r.Post("/auth/admin/demote", func(w http.ResponseWriter, r *http.Request) {
		authz := r.Header.Get("Authorization")
		if !strings.HasPrefix(authz, "Bearer ") {
			middleware.ErrorHandler(w, http.StatusUnauthorized, "missing token", "UNAUTHORIZED")
			return
		}
		claims, err := verifyToken(strings.TrimPrefix(authz, "Bearer "))
		if err != nil {
			middleware.ErrorHandler(w, http.StatusUnauthorized, "invalid token", "UNAUTHORIZED")
			return
		}
		isAdmin := false
		for _, role := range claims.Roles {
			if role == "admin" {
				isAdmin = true
				break
			}
		}
		if !isAdmin {
			middleware.ErrorHandler(w, http.StatusForbidden, "admin role required", "FORBIDDEN")
			return
		}
		var req struct {
			Email string `json:"email"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Email == "" {
			middleware.ErrorHandler(w, http.StatusBadRequest, "invalid JSON", "INVALID_JSON")
			return
		}
		if impl.store == nil || impl.store.Pool == nil {
			middleware.ErrorHandler(w, http.StatusInternalServerError, "store not ready", "INTERNAL_ERROR")
			return
		}
		if err := impl.store.DemoteAdminByEmail(r.Context(), req.Email); err != nil {
			middleware.ErrorHandler(w, http.StatusInternalServerError, "db error", "INTERNAL_ERROR")
			return
		}
		_ = impl.store.InsertAdminAudit(r.Context(), claims.Sub, req.Email, "demote", "")
		w.WriteHeader(http.StatusNoContent)
	})

	// Admin audit read (admin-only)
	r.Get("/auth/admin/audit", func(w http.ResponseWriter, r *http.Request) {
		authz := r.Header.Get("Authorization")
		if !strings.HasPrefix(authz, "Bearer ") {
			middleware.ErrorHandler(w, http.StatusUnauthorized, "missing token", "UNAUTHORIZED")
			return
		}
		claims, err := verifyToken(strings.TrimPrefix(authz, "Bearer "))
		if err != nil {
			middleware.ErrorHandler(w, http.StatusUnauthorized, "invalid token", "UNAUTHORIZED")
			return
		}
		isAdmin := false
		for _, role := range claims.Roles {
			if role == "admin" {
				isAdmin = true
				break
			}
		}
		if !isAdmin {
			middleware.ErrorHandler(w, http.StatusForbidden, "admin role required", "FORBIDDEN")
			return
		}
		limit := 50
		if v := r.URL.Query().Get("limit"); v != "" {
			if n, e := strconv.Atoi(v); e == nil {
				limit = n
			}
		}
		if impl.store == nil || impl.store.Pool == nil {
			middleware.ErrorHandler(w, http.StatusInternalServerError, "store not ready", "INTERNAL_ERROR")
			return
		}
		items, err := impl.store.ListAdminAudit(r.Context(), limit)
		if err != nil {
			middleware.ErrorHandler(w, http.StatusInternalServerError, "db error", "INTERNAL_ERROR")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"items": items})
	})

	// Host onboarding upsert (user)
	r.Post("/host/onboarding", func(w http.ResponseWriter, r *http.Request) {
		authz := r.Header.Get("Authorization")
		if !strings.HasPrefix(authz, "Bearer ") {
			middleware.ErrorHandler(w, http.StatusUnauthorized, "missing token", "UNAUTHORIZED")
			return
		}
		claims, err := verifyToken(strings.TrimPrefix(authz, "Bearer "))
		if err != nil {
			middleware.ErrorHandler(w, http.StatusUnauthorized, "invalid token", "UNAUTHORIZED")
			return
		}
		var req struct {
			ServiceType *string        `json:"serviceType"`
			Data        map[string]any `json:"data"`
			Progress    *int           `json:"progress"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			middleware.ErrorHandler(w, http.StatusBadRequest, "invalid JSON", "INVALID_JSON")
			return
		}
		if req.ServiceType != nil && !allowedServiceTypes[*req.ServiceType] {
			middleware.ErrorHandler(w, http.StatusBadRequest, "invalid serviceType", "VALIDATION_ERROR")
			return
		}
		p := 0
		if req.Progress != nil {
			p = *req.Progress
		}
		if impl.store == nil || impl.store.Pool == nil {
			middleware.ErrorHandler(w, http.StatusInternalServerError, "store not ready", "INTERNAL_ERROR")
			return
		}
		if err := impl.store.UpsertHostOnboarding(r.Context(), claims.Sub, req.ServiceType, req.Data, p); err != nil {
			middleware.ErrorHandler(w, http.StatusInternalServerError, "db error", "INTERNAL_ERROR")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	// Host onboarding get (user)
	r.Get("/host/onboarding", func(w http.ResponseWriter, r *http.Request) {
		authz := r.Header.Get("Authorization")
		if !strings.HasPrefix(authz, "Bearer ") {
			middleware.ErrorHandler(w, http.StatusUnauthorized, "missing token", "UNAUTHORIZED")
			return
		}
		claims, err := verifyToken(strings.TrimPrefix(authz, "Bearer "))
		if err != nil {
			middleware.ErrorHandler(w, http.StatusUnauthorized, "invalid token", "UNAUTHORIZED")
			return
		}
		if impl.store == nil || impl.store.Pool == nil {
			middleware.ErrorHandler(w, http.StatusInternalServerError, "store not ready", "INTERNAL_ERROR")
			return
		}
		h, err := impl.store.GetHostOnboarding(r.Context(), claims.Sub)
		if err != nil {
			middleware.ErrorHandler(w, http.StatusInternalServerError, "db error", "INTERNAL_ERROR")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(h)
	})

	// Phone-first auth
	r.Post("/auth/phone/start", impl.PostAuthPhoneStart)
	r.Post("/auth/phone/verify", impl.PostAuthPhoneVerify)

	// Contacts match (privacy-first)
	r.Post("/contacts/match", impl.PostContactsMatch)

	return h
}
