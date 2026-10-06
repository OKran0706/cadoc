package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
)

func main() {
	http.HandleFunc("/events", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		fmt.Printf("RECEIVED_EVENT: %s\n", string(body))
		w.WriteHeader(http.StatusOK)
		
		// Signal success
		os.WriteFile("e2e-success.tmp", []byte("ok"), 0644)
	})
	
	fmt.Println("Mock server listening on :8080...")
	log.Fatal(http.ListenAndServe(":8080", nil))
}
