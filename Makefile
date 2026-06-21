.PHONY: install dev tui install-cli test typecheck

install:
	pnpm install
	cd packages/workspace/node_modules/better-sqlite3 2>/dev/null && npm run build-release || true

dev:
	pnpm --filter @academic-agent/app dev

tui:
	pnpm --filter @academic-agent/app start

install-cli:
	pnpm link --global

typecheck:
	pnpm -r typecheck

test:
	pnpm test
