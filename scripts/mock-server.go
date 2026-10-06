package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
)

func main() {
	port := "8080"
	if len(os.Args) > 1 {
		port = os.Args[1]
	}

	http.HandleFunc("/events", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "Failed to read body", http.StatusInternalServerError)
			return
		}
		defer r.Body.Close()

		// Attempt to parse as signed envelope
		var envelope struct {
			Payload string `json:"payload"`
		}
		var eventType string
		if err := json.Unmarshal(body, &envelope); err == nil {
			var eventData map[string]interface{}
			if err := json.Unmarshal([]byte(envelope.Payload), &eventData); err == nil {
				if t, ok := eventData["type"].(string); ok {
					eventType = t
				}
			}
		}

		if eventType == "SENTINEL_FILE_TAMPER" {
			log.Printf("!!! TAMPER ALERT RECEIVED !!!")
		}
		log.Printf("Received event [type=%s]: %s", eventType, string(body))

		w.WriteHeader(http.StatusOK)
	})

	log.Printf("Mock Ingestion Server listening on 0.0.0.0:%s", port)
	if err := http.ListenAndServe("0.0.0.0:"+port, nil); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
