# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY . .
WORKDIR /app/services/auth-service
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /bin/auth ./cmd/auth-service

FROM gcr.io/distroless/base-debian12:nonroot
USER nonroot
# Include OpenAPI spec and migrations for runtime validation & migrations
COPY --from=builder /app/apis/auth.openapi.yaml /apis/auth.openapi.yaml
COPY --from=builder /app/services/auth-service/migrations /migrations
COPY --from=builder /bin/auth /auth
EXPOSE 8080
ENTRYPOINT ["/auth"]
