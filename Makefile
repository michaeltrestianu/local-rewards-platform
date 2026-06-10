.PHONY: up down logs perf

up:
	docker compose up -d --wait

down:
	docker compose down -v

logs:
	docker compose logs -f postgres

# Combined e2e load test: sessions minted by identity-service (:8080) spent
# against ledger-service (:8081). Both services must be running in platform
# mode (`make up-platform` in each repo). SMOKE=1 for a quick harness check.
perf:
	@curl -sf http://localhost:8081/healthz >/dev/null || { echo "ledger-service not on :8081 — run 'make up-platform' in ledger-service"; exit 1; }
	@curl -sf http://localhost:8080/healthz >/dev/null || { echo "identity-service not on :8080 — run 'make up-platform' in identity-service"; exit 1; }
	./prep-admin.sh
	docker run --rm --add-host=host.docker.internal:host-gateway \
		-v $(CURDIR)/perf:/perf \
		-e IDENTITY_URL=http://host.docker.internal:8080 \
		-e LEDGER_URL=http://host.docker.internal:8081 \
		-e SMOKE=$(SMOKE) \
		grafana/k6 run /perf/e2e.js
