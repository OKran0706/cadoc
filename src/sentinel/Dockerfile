FROM golang:1.21-alpine AS builder
WORKDIR /app

# The code requires some go modules, assuming go.mod is present
COPY go.mod ./
# (Optional: COPY go.sum ./ && go mod download)

COPY . .
# We build sentinel-a
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o sentinel-a ./cmd/sentinel-a

FROM alpine:latest
RUN apk add --no-cache ca-certificates tzdata

# Create runtime directories for PID locks and local sockets
RUN mkdir -p /run/canary && chmod 777 /run/canary

COPY --from=builder /app/sentinel-a /usr/local/bin/sentinel-a

ENTRYPOINT ["/usr/local/bin/sentinel-a"]
