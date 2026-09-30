FROM golang:1.21-alpine AS builder
WORKDIR /app

# The code requires some go modules, assuming go.mod is present
COPY go.mod ./
# (Optional: COPY go.sum ./ && go mod download)

COPY . .
# We build sentinel-a
RUN apk add --no-cache git
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o sentinel-a ./cmd/sentinel-a

FROM alpine:latest
RUN apk add --no-cache ca-certificates tzdata

# Create runtime directories for PID locks and local sockets
RUN mkdir -p /run/canary /opt/canary/config /opt/canary/templates /opt/canary/deployed && chmod 777 /run/canary /opt/canary/deployed

COPY --from=builder /app/sentinel-a /usr/local/bin/sentinel-a
COPY --from=builder /app/templates /opt/sentinel/templates

ENTRYPOINT ["/usr/local/bin/sentinel-a"]
