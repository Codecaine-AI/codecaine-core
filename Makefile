.PHONY: observatory docker-up docker-down help

observatory:
	@if [ ! -d observatory/node_modules ]; then cd observatory && bun install; fi
	cd observatory && bun run dev

docker-up:
	docker compose up --build -d

docker-down:
	docker compose down

help:
	@echo "Available targets:"
	@echo "  observatory  Install dependencies if needed and start the observatory development server"
	@echo "  docker-up    Build and start the container development runtime in the background"
	@echo "  docker-down  Stop the container development runtime"
	@echo "  help         Show this help message"
