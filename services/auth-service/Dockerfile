# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY services/auth-service/go.mod services/auth-service/go.sum ./
RUN go mod download || true
COPY services/auth-service ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /bin/auth ./cmd/auth-service

FROM gcr.io/distroless/base-debian12:nonroot
USER nonroot
# Include OpenAPI spec and migrations for runtime validation & migrations
COPY apis/auth.openapi.yaml /apis/auth.openapi.yaml
COPY services/auth-service/migrations /migrations
COPY --from=builder /bin/auth /auth
EXPOSE 8090
ENTRYPOINT ["/auth"]

