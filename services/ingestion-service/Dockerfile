# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY services/ingestion-service/go.mod services/ingestion-service/go.sum ./
RUN go mod download
COPY services/ingestion-service ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /bin/ingestion ./cmd/ingestion-service

FROM gcr.io/distroless/base-debian12:nonroot
USER nonroot
COPY --from=builder /bin/ingestion /ingestion
EXPOSE 8080
ENTRYPOINT ["/ingestion"]

