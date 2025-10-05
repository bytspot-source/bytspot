package main

import (
	"log"
	"net/http"
	"os"

	"bytspot/services/valet-service/internal/server"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" { port = "8096" }
	log.Printf("valet-service listening on :%s", port)
	http.ListenAndServe(":"+port, server.NewRouter())
}

