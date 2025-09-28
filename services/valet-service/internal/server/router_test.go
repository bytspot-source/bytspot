package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestValetIntake_Valid(t *testing.T) {
	h := NewRouter()
	body := map[string]any{
		"userId": "u1",
		"vehicle": map[string]string{"make": "Tesla", "model": "3", "plate": "XYZ", "color": "Blue"},
		"spot": "A12",
		"services": []string{"basic_wash"},
		"photos": []string{},
	}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/valet/intake", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["ticket"] == nil {
		t.Fatalf("expected ticket id in response")
	}
}

func TestValetIntake_Invalid(t *testing.T) {
	h := NewRouter()
	body := map[string]any{"vehicle": map[string]string{"make": "A", "model": "B"}}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/valet/intake", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestValetStatus_UpdateFlow(t *testing.T) {
	h := NewRouter()
	// create ticket
	intake := map[string]any{
		"userId": "u2",
		"vehicle": map[string]string{"make": "BMW", "model": "X5"},
	}
	b, _ := json.Marshal(intake)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/valet/intake", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK { t.Fatalf("intake failed: %d", w.Code) }
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	id := resp["ticket"].(string)
	// update status
	st := map[string]string{"status":"service_in_progress"}
	sb, _ := json.Marshal(st)
	w2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPatch, "/valet/vehicles/"+id+"/status", bytes.NewReader(sb))
	req2.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(w2, req2)
	if w2.Code != http.StatusNoContent { t.Fatalf("expected 204, got %d: %s", w2.Code, w2.Body.String()) }
	// bad id
	w3 := httptest.NewRecorder()
	req3 := httptest.NewRequest(http.MethodPatch, "/valet/vehicles/bad/status", bytes.NewReader(sb))
	req3.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(w3, req3)
	if w3.Code != http.StatusNotFound { t.Fatalf("expected 404, got %d", w3.Code) }
}

