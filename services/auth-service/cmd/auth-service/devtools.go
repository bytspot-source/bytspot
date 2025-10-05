package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"

	"bytspot/services/auth-service/internal/server"
)

// Simple dev-only endpoint to promote a user to admin by email.
// Enabled only when DEV_ENABLE_ADMIN_PROMOTE=true
func devRoutes(mux *http.ServeMux, impl *server.ServerImpl) {
	if os.Getenv("DEV_ENABLE_ADMIN_PROMOTE") != "true" { return }

	mux.HandleFunc("/dev/promote-admin", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost { w.WriteHeader(http.StatusMethodNotAllowed); return }
		var req struct{ Email string `json:"email"` }
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil { w.WriteHeader(http.StatusBadRequest); return }
		if req.Email == "" { w.WriteHeader(http.StatusBadRequest); return }
		if err := impl.Store().PromoteAdminByEmail(r.Context(), req.Email); err != nil {
			log.Printf("promote-admin error: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

