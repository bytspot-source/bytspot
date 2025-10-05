// Placeholder for oapi-codegen output. Replace by running `make generate-api`.
package api

import "net/http"

type ServerInterface interface {
	GetHealthz(w http.ResponseWriter, r *http.Request)
	GetReadyz(w http.ResponseWriter, r *http.Request)
	PostAuthRegister(w http.ResponseWriter, r *http.Request)
	PostAuthLogin(w http.ResponseWriter, r *http.Request)
	GetAuthMe(w http.ResponseWriter, r *http.Request)
}

// Lightweight route binder compatible with chi
func HandlerFromMux(si ServerInterface, r chiRouter) http.Handler {
	r.Get("/healthz", si.GetHealthz)
	r.Get("/readyz", si.GetReadyz)
	r.Post("/auth/register", si.PostAuthRegister)
	r.Post("/auth/login", si.PostAuthLogin)
	r.Get("/auth/me", si.GetAuthMe)
	return r
}

type chiRouter interface {
	Get(string, http.HandlerFunc)
	Post(string, http.HandlerFunc)
	ServeHTTP(http.ResponseWriter, *http.Request)
}
