package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	"bytspot/services/venue-service/internal/server"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8092"
	}
	addr := fmt.Sprintf(":%s", port)

	r := server.NewRouter()

	log.Printf("venue-service listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, r))
}

