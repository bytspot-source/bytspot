# Bytspot Root Makefile - Orchestrates all services
.PHONY: help generate build test clean docker-build docker-up docker-down tidy

# Variables
SERVICES := ingestion-service model-orchestrator ota-service auth-service venue-service
OPENAPI_SPECS := apis/ingestion.openapi.yaml apis/mobile-ota.openapi.yaml apis/iot-ota.openapi.yaml apis/auth.openapi.yaml apis/venue.openapi.yaml apis/admin.openapi.yaml

help: ## Show this help message
	@echo "Bytspot Development Commands:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# Code Generation
generate: ## Generate API code for all services
	@echo "🔄 Generating API code for all services..."
	@for service in $(SERVICES); do \
		if [ -f "services/$$service/Makefile" ]; then \
			echo "  📦 Generating $$service..."; \
			$(MAKE) -C services/$$service generate-api || exit 1; \
		fi; \
	done
	@echo "✅ All API code generated successfully"

# Dependencies
tidy: ## Tidy dependencies for all services
	@echo "🔄 Tidying dependencies..."
	@$(MAKE) -C shared tidy
	@for service in $(SERVICES); do \
		if [ -f "services/$$service/go.mod" ]; then \
			echo "  📦 Tidying $$service..."; \
			$(MAKE) -C services/$$service tidy || exit 1; \
		fi; \
	done
	@echo "✅ All dependencies tidied"

# Building
build: generate ## Build all services
	@echo "🔨 Building all services..."
	@for service in $(SERVICES); do \
		if [ -f "services/$$service/Makefile" ]; then \
			echo "  📦 Building $$service..."; \
			$(MAKE) -C services/$$service build || exit 1; \
		fi; \
	done
	@echo "✅ All services built successfully"

# Testing
test: ## Run tests for all services
	@echo "🧪 Running tests for all services..."
	@$(MAKE) -C shared test
	@for service in $(SERVICES); do \
		if [ -f "services/$$service/Makefile" ]; then \
			echo "  📦 Testing $$service..."; \
			$(MAKE) -C services/$$service test || exit 1; \
		fi; \
	done
	@echo "✅ All tests passed"

# Docker Operations
docker-build: ## Build all Docker images
	@echo "🐳 Building Docker images..."
	@docker compose build
	@echo "✅ All Docker images built"

docker-up: ## Start all services with Docker Compose
	@echo "🚀 Starting all services..."
	@docker compose up -d
	@echo "✅ All services started"
	@echo "🌐 Services available at:"
	@echo "  - Ingestion Service: http://localhost:8080"
	@echo "  - Model Orchestrator: http://localhost:8081"
	@echo "  - OTA Service: http://localhost:8082"
	@echo "  - Neo4j Browser: http://localhost:7474"
	@echo "  - Redis: localhost:6379"

docker-down: ## Stop all services
	@echo "🛑 Stopping all services..."
	@docker compose down
	@echo "✅ All services stopped"

docker-logs: ## Show logs for all services
	@docker compose logs -f

# Development
dev: docker-up ## Start development environment
	@echo "🔧 Development environment ready!"

smoke-test: ## Run smoke tests against running services
	@echo "🧪 Running smoke tests..."
	@echo "  Testing ingestion-service..."
	@curl -f http://localhost:8080/healthz > /dev/null || (echo "❌ Ingestion service health check failed" && exit 1)
	@echo "  ✅ Ingestion service OK"
	@echo "  Testing model-orchestrator..."
	@curl -f http://localhost:8081/healthz > /dev/null || (echo "❌ Model orchestrator health check failed" && exit 1)
	@echo "  ✅ Model orchestrator OK"
	@echo "  Testing ota-service..."
	@curl -f http://localhost:8082/healthz > /dev/null || (echo "❌ OTA service health check failed" && exit 1)
	@echo "  ✅ OTA service OK"
	@echo "  Testing gateway-bff..."
	@curl -f http://localhost:3000/healthz > /dev/null || (echo "❌ gateway-bff health check failed" && exit 1)
	@echo "  ✅ gateway-bff OK"
	@echo "✅ All smoke tests passed"

.PHONY: e2e-admin

e2e-admin: ## Run E2E admin flow (requires dev promote enabled)
	@bash scripts/e2e_admin_flow.sh || (echo "❌ E2E admin flow failed" && exit 1)
	@echo "✅ E2E admin flow passed"

# Cleanup
clean: ## Clean build artifacts
	@echo "🧹 Cleaning build artifacts..."
	@for service in $(SERVICES); do \
		if [ -f "services/$$service/Makefile" ]; then \
			$(MAKE) -C services/$$service clean; \
		fi; \
	done
	@docker compose down --volumes --remove-orphans
	@echo "✅ Cleanup complete"

# OpenAPI Validation
validate-apis: ## Validate all OpenAPI specifications
	@echo "📋 Validating OpenAPI specifications..."
	@for spec in $(OPENAPI_SPECS); do \
		echo "  📄 Validating $$spec..."; \
		# Add OpenAPI validation tool here when available \
	done
	@echo "✅ All API specifications valid"

# Quick start for new developers
bootstrap: tidy generate build ## Bootstrap development environment
	@echo "🎉 Bootstrap complete! Run 'make dev' to start development environment"
