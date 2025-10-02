# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git ca-certificates

WORKDIR /app

# Copy the entire project (needed for shared modules and APIs)
COPY . .

# Build the auth service
WORKDIR /app/loc-byt/services/auth-service
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /bin/auth ./cmd/auth-service

FROM gcr.io/distroless/base-debian12:nonroot
USER nonroot

# Copy OpenAPI spec and migrations for runtime validation & migrations
COPY --from=builder /app/loc-byt/apis/auth.openapi.yaml /apis/auth.openapi.yaml
COPY --from=builder /app/loc-byt/services/auth-service/migrations /migrations
COPY --from=builder /bin/auth /auth

EXPOSE 8080
ENTRYPOINT ["/auth"]
