.PHONY: dev dev-down kind kind-down migrate
dev:
	docker compose -f infra/local/docker-compose.yml up -d --wait
dev-down:
	docker compose -f infra/local/docker-compose.yml down
kind:
	kind get clusters | grep -q '^ai-employee$$' || kind create cluster --config infra/local/kind.yaml
kind-down:
	kind delete cluster --name ai-employee
migrate:
	pnpm --filter @ai-employee/control-plane migrate
