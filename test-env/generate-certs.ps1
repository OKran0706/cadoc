# test-env/generate-certs.ps1

If (!(Test-Path certs)) {
    New-Item -ItemType Directory -Force -Path certs
}
Set-Location -Path certs

Write-Host "Generating CA..."
openssl req -new -x509 -keyout ca.key -out ca.crt -days 365 -nodes -subj "/CN=Canary CA"

Write-Host "Generating Server (Kafka) Certs..."
openssl req -newkey rsa:2048 -nodes -keyout kafka.key -out kafka.csr -subj "/CN=localhost"
openssl x509 -req -in kafka.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out kafka.crt -days 365

Write-Host "Generating Client (Sentinel) Certs..."
openssl req -newkey rsa:2048 -nodes -keyout client.key -out client.csr -subj "/CN=agent:acme:sentinel-node-staging"
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt -days 365

Write-Host "Formatting for Bitnami Kafka (PEM)..."
Get-Content kafka.crt, kafka.key | Set-Content kafka.keystore.pem
Copy-Item ca.crt -Destination kafka.truststore.pem

Write-Host "Done! Certificates generated in test-env/certs/"
Write-Host "CA Cert: test-env/certs/ca.crt"
Write-Host "Client Cert: test-env/certs/client.crt"
Write-Host "Client Key: test-env/certs/client.key"
