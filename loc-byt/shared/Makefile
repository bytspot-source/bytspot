# Shared Package Makefile

.PHONY: test tidy clean

test:
	@echo "🧪 Running tests for shared package..."
	@go test ./...

tidy:
	@echo "📦 Tidying shared dependencies..."
	@go mod tidy

clean:
	@echo "🧹 Cleaning shared package..."
	@go clean ./...
