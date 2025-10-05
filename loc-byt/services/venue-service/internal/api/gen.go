// Placeholder for oapi-codegen output. Replace by running `make generate-api`.
package api

import (
	"net/http"
	"strings"
)

type GetVenuesDiscoverParams struct {
	Lat    float64  `json:"lat"`
	Lon    float64  `json:"lon"`
	Radius *float64 `json:"radius,omitempty"`
}

type ServerInterface interface {
	GetHealthz(w http.ResponseWriter, r *http.Request)
	GetReadyz(w http.ResponseWriter, r *http.Request)
	GetVenuesDiscover(w http.ResponseWriter, r *http.Request, params GetVenuesDiscoverParams)
	GetVenuesId(w http.ResponseWriter, r *http.Request, id string)
	PostVenuesIdLike(w http.ResponseWriter, r *http.Request, id string)
	PostVenuesIdVibe(w http.ResponseWriter, r *http.Request, id string)
	GetVenuesIdVibeAggregate(w http.ResponseWriter, r *http.Request, id string)
}

type chiRouter interface {
	Get(string, http.HandlerFunc)
	Post(string, http.HandlerFunc)
	ServeHTTP(http.ResponseWriter, *http.Request)
}

func pathParam(path, prefix, suffix string) string {
	id := strings.TrimPrefix(path, prefix)
	if suffix != "" && strings.HasSuffix(id, suffix) {
		id = strings.TrimSuffix(id, suffix)
	}
	if i := strings.IndexByte(id, '/'); i >= 0 {
		id = id[:i]
	}
	return id
}

func HandlerFromMux(si ServerInterface, r chiRouter) http.Handler {
	r.Get("/healthz", si.GetHealthz)
	r.Get("/readyz", si.GetReadyz)
	r.Get("/venues/discover", func(w http.ResponseWriter, req *http.Request) {
		// Basic parsing; real codegen will generate robust parsing
		params := GetVenuesDiscoverParams{}
		si.GetVenuesDiscover(w, req, params)
	})
	r.Get("/venues/{id}", func(w http.ResponseWriter, req *http.Request) {
		si.GetVenuesId(w, req, pathParam(req.URL.Path, "/venues/", ""))
	})
	r.Post("/venues/{id}/like", func(w http.ResponseWriter, req *http.Request) {
		si.PostVenuesIdLike(w, req, pathParam(req.URL.Path, "/venues/", "/like"))
	})
	r.Post("/venues/{id}/vibe", func(w http.ResponseWriter, req *http.Request) {
		si.PostVenuesIdVibe(w, req, pathParam(req.URL.Path, "/venues/", "/vibe"))
	})
	r.Get("/venues/{id}/vibe-aggregate", func(w http.ResponseWriter, req *http.Request) {
		si.GetVenuesIdVibeAggregate(w, req, pathParam(req.URL.Path, "/venues/", "/vibe-aggregate"))
	})
	return r
}
