package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	"bytspot/pkg/server"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	addr := fmt.Sprintf(":%s", port)

	r := server.NewIngestionRouter()

	log.Printf("ingestion-service listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, r))
}
