PYTHON := conda run -n academic-agent env PYTHONNOUSERSITE=1 python
UVICORN := conda run -n academic-agent env PYTHONNOUSERSITE=1 uvicorn

.PHONY: install dev-core dev-tui tui install-cli schema test test-python typecheck

install:
	$(PYTHON) -m pip install -r requirements.txt
	pnpm install

dev-core:
	$(UVICORN) academic_agent_core.api:app --app-dir services/core/src --reload --host 127.0.0.1 --port 8765

dev-tui:
	pnpm --filter @academic-agent/tui dev

tui:
	pnpm tui

install-cli:
	pnpm link --global

schema:
	$(PYTHON) scripts/export_schema.py

test-python:
	$(PYTHON) -m pytest services/core/tests

typecheck:
	pnpm -r typecheck

test: schema test-python typecheck
