package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"

	"bytspot/services/auth-service/internal/server"
)

func main() {
	// Optionally run migrations at startup if DATABASE_URL present
	if err := runMigrations(); err != nil {
		log.Printf("migrations failed: %v", err)
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8090"
	}
	addr := fmt.Sprintf(":%s", port)

	r := server.NewRouter()
	// Initialize DB-backed serverImpl for dev tools
	impl, err := server.NewServerImpl(context.Background())
	if err != nil {
		log.Fatalf("failed to init server: %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("/", r)
	devRoutes(mux, impl)

	log.Printf("auth-service listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

