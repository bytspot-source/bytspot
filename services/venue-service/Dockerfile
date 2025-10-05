# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY services/venue-service/go.mod services/venue-service/go.sum ./
RUN go mod download || true
COPY services/venue-service ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /bin/venue ./cmd/venue-service

FROM gcr.io/distroless/base-debian12:nonroot
USER nonroot
# Include OpenAPI spec for runtime validation
COPY apis/venue.openapi.yaml /apis/venue.openapi.yaml
COPY --from=builder /bin/venue /venue
EXPOSE 8092
ENTRYPOINT ["/venue"]

