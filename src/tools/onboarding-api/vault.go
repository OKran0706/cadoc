package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"net/http"
	"os"
)

type VaultTokenRequest struct {
	Policies []string          `json:"policies"`
	Meta     map[string]string `json:"meta"`
	TTL      string            `json:"ttl"`
}

type VaultAuthResponse struct {
	Auth struct {
		ClientToken string `json:"client_token"`
	} `json:"auth"`
}

func CreateScopedToken(serverID string) (string, error) {
	vaultAddr := os.Getenv("VAULT_ADDR")
	if vaultAddr == "" {
		return "", fmt.Errorf("VAULT_ADDR environment variable is required")
	}

	appToken := os.Getenv("VAULT_TOKEN")
	if appToken == "" {
		return "", fmt.Errorf("VAULT_TOKEN environment variable is required")
	}

	url := fmt.Sprintf("%s/v1/auth/token/create", vaultAddr)

	reqBody := VaultTokenRequest{
		Policies: []string{"canary-sentinel-policy"}, // Specific policy restricted for sentinels
		Meta: map[string]string{
			"server_id": serverID,
		},
		TTL: "1h", // Short-lived token for initial boot
	}

	jsonValue, _ := json.Marshal(reqBody)
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonValue))
	if err != nil {
		return "", err
	}

	req.Header.Set("X-Vault-Token", appToken)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := ioutil.ReadAll(resp.Body)
		return "", fmt.Errorf("vault returned status %d: %s", resp.StatusCode, string(body))
	}

	var vaultResp VaultAuthResponse
	if err := json.NewDecoder(resp.Body).Decode(&vaultResp); err != nil {
		return "", err
	}

	return vaultResp.Auth.ClientToken, nil
}
