# Venue Service Makefile

SERVICE_NAME=venue-service
OPENAPI=../../apis/venue.openapi.yaml
API_PKG=internal/api
BIN_DIR=../../bin

.PHONY: gen generate-api build run test clean tidy

generate-api: gen

gen:
	@echo "🔄 Generating OpenAPI code from $(OPENAPI)"
	@go install github.com/deepmap/oapi-codegen/v2/cmd/oapi-codegen@latest
	@oapi-codegen -generate chi-server,types -package api -o $(API_PKG)/gen.go $(OPENAPI)
	@echo "✅ API code generated successfully"

build: generate-api
	@echo "🔨 Building $(SERVICE_NAME)..."
	@mkdir -p $(BIN_DIR)
	@go build -o $(BIN_DIR)/$(SERVICE_NAME) ./cmd/$(SERVICE_NAME)
	@echo "✅ Build complete: $(BIN_DIR)/$(SERVICE_NAME)"

run:
	@echo "🚀 Running $(SERVICE_NAME)..."
	@go run ./cmd/$(SERVICE_NAME)

test:
	@go test ./...

clean:
	@rm -f $(BIN_DIR)/$(SERVICE_NAME)
	@rm -f $(API_PKG)/gen.go

tidy:
	@go mod tidy

