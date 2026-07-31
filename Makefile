.PHONY: observatory help

observatory:
	@if [ ! -d observatory/node_modules ]; then cd observatory && bun install; fi
	cd observatory && bun run dev

help:
	@echo "Available targets:"
	@echo "  observatory  Install dependencies if needed and start the observatory development server"
	@echo "  help         Show this help message"
