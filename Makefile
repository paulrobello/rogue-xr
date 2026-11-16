.PHONY: install build test lint fmt typecheck checkall checkall-ci dev dev-start dev-stop dev-restart preview hooks

DEV_PORT := 4260
DEV_WINDOW := rogue-xr-dev

install: hooks
	bun install --frozen-lockfile
hooks:
	git config core.hooksPath .githooks
build:
	bun run build
test:
	bun run test
lint:
	bun run lint
fmt:
	bun run fmt
typecheck:
	bun run typecheck
checkall: lint typecheck test build
checkall-ci: checkall
	gitleaks dir . --redact --no-banner

# Room asset gate: presence, hashes against provenance and PRD budgets (no Blender needed).
.PHONY: asset-check
asset-check:
	python3 -I scripts/assets/asset-check.py

# Foreground dev server (port 4260).
dev:
	bun run dev
# Background dev server in a par-mux window; stop it with `make dev-stop`.
dev-start:
	par-mux --cmd "new-window -n $(DEV_WINDOW) -- sh -c 'cd $(CURDIR) && make dev'"
dev-stop:
	@pids=$$(lsof -ti tcp:$(DEV_PORT) -sTCP:LISTEN); \
	if [ -n "$$pids" ]; then kill $$pids && echo "dev-stop: stopped $$pids"; else echo "dev-stop: nothing on $(DEV_PORT)"; fi
dev-restart: dev-stop dev-start
preview:
	bun run preview
