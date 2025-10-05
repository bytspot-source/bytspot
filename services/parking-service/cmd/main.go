package main

import (
	"log"
	"net/http"
	"os"

	"bytspot/services/parking-service/internal/server"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" { port = "8094" }
	log.Printf("parking-service listening on :%s", port)
	http.ListenAndServe(":"+port, server.NewRouter())
}

