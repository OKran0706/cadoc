package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
)

type DeployRequest struct {
	ServerID string `json:"server_id"`
}

func authMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		expectedToken := os.Getenv("API_AUTH_TOKEN")
		if expectedToken != "" {
			authHeader := r.Header.Get("Authorization")
			tokenParts := strings.SplitN(authHeader, " ", 2)
			if len(tokenParts) != 2 || tokenParts[0] != "Bearer" || tokenParts[1] != expectedToken {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
		}
		next.ServeHTTP(w, r)
	}
}

func onboardHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req DeployRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	if req.ServerID == "" {
		http.Error(w, "server_id is required", http.StatusBadRequest)
		return
	}

	// Request dynamically scoped token mapped specifically to this node
	token, err := CreateScopedToken(req.ServerID)
	if err != nil {
		log.Printf("Failed to create vault token for %s: %v", req.ServerID, err)
		http.Error(w, "Internal server error during token generation", http.StatusInternalServerError)
		return
	}

	downloadURL := os.Getenv("CANARY_DOWNLOAD_URL")
	if downloadURL == "" {
		downloadURL = "https://canary-binary-store/sentinel" // fallback default
	}

	// Output flat string, ready for piping directly to bash or copying into a terminal
	command := fmt.Sprintf("curl -sL %s -o /tmp/sentinel && chmod +x /tmp/sentinel && VAULT_TOKEN=%s /tmp/sentinel -id %s\n", downloadURL, token, req.ServerID)
	
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(command))
}

func main() {
	http.HandleFunc("/v1/onboard", authMiddleware(onboardHandler))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	fmt.Printf("Secure Onboarding API starting on :%s...\n", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
