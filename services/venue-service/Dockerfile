# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git ca-certificates

WORKDIR /app

# Copy the entire project (needed for shared modules and APIs)
COPY . .

# Build the venue service
WORKDIR /app/loc-byt/services/venue-service
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /bin/venue ./cmd/venue-service

FROM gcr.io/distroless/base-debian12:nonroot
USER nonroot

# Copy OpenAPI spec for runtime validation
COPY --from=builder /app/loc-byt/apis/venue.openapi.yaml /apis/venue.openapi.yaml
COPY --from=builder /bin/venue /venue

EXPOSE 8080
ENTRYPOINT ["/venue"]
