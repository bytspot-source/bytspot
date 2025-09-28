package server

import (
    "encoding/json"
    "net/http"

    "bytspot/shared/middleware"
)

// POST /contacts/match { hashes: string[] }
func (s *ServerImpl) PostContactsMatch(w http.ResponseWriter, r *http.Request) {
    var req struct { Hashes []string `json:"hashes"` }
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.Hashes) == 0 {
        middleware.ErrorHandler(w, http.StatusBadRequest, "invalid payload", "VALIDATION_ERROR"); return
    }
    if s.store == nil || s.store.Pool == nil { middleware.ErrorHandler(w, http.StatusInternalServerError, "store not ready", "INTERNAL_ERROR"); return }
    // Simple match query: SELECT id, phone_hash FROM users WHERE phone_hash IN (...)
    rows, err := s.store.Pool.Query(r.Context(), `SELECT id, phone_hash FROM users WHERE phone_hash = ANY($1)`, req.Hashes)
    if err != nil { middleware.ErrorHandler(w, http.StatusInternalServerError, "db error", "INTERNAL_ERROR"); return }
    defer rows.Close()
    type match struct { ID string `json:"id"`; Hash string `json:"hash"` }
    var matches []match
    for rows.Next() {
        var id, h string
        if err := rows.Scan(&id, &h); err == nil { matches = append(matches, match{ID: id, Hash: h}) }
    }
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]any{"matches": matches})
}

