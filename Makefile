# This service on its own: its containers plus the shared RabbitMQ and Redis, without the other services or the edge
# (REST and gRPC straight on the host ports). The whole platform is `make up` in backend/ or at the repository root.
#
#   make up                              create the missing .env files, build and start this service (healthy), then migrate
#   make watch                           same, in the foreground with Compose Watch (code changes without rebuild)
#   make down                            stop and remove this service's containers (RabbitMQ, Redis and the volumes stay)
#   make ps                              this service's containers and their health
#   make logs                            follow this service's logs
#
# Laravel-style migration commands. They run inside the running wallet-api container (same image, same .env),
# so the service must be up (make up here, or the whole platform):
#
#   make migrate                         run the pending migrations as one batch
#   make migrate-rollback                undo the last batch
#   make migrate-status                  list every migration and whether it ran
#   make migrate-fresh                   drop every table and migrate again
#   make migration name=create_x_table   create src/infra/database/migrations/<timestamp>_create_x_table.ts
#   make deps                            install node_modules and generate the gRPC code on your machine, for the editor
#
# Tests (all in containers; the platform does not need to be up):
#   make test                            every kind of test: test-unit, then test-integration
#   make test-unit                       typecheck, lint, architecture rules and unit tests
#   make test-integration                integration and contract tests against ephemeral Postgres, RabbitMQ and Redis

COMPOSE = docker compose -f ../docker-compose.yml
CONTAINERS = wallet-db wallet-api wallet-worker
MIGRATIONS = src/infra/database/migrations

.PHONY: up watch down ps logs migrate migrate-rollback migrate-status migrate-fresh migration deps test test-unit test-integration

# backend/docker-compose.yml includes every service, so it needs every .env; `make env` there only creates the missing ones.
up:
	@$(MAKE) --no-print-directory -C .. env
	$(COMPOSE) up -d --build --wait rabbitmq redis $(CONTAINERS)
	@$(MAKE) --no-print-directory migrate

watch:
	@$(MAKE) --no-print-directory -C .. env
	$(COMPOSE) up --build --watch rabbitmq redis $(CONTAINERS)

down:
	$(COMPOSE) rm --stop --force $(CONTAINERS)

ps:
	$(COMPOSE) ps --format 'table {{.Name}}\t{{.Status}}' $(CONTAINERS)

logs:
	$(COMPOSE) logs -f $(CONTAINERS)

migrate:
	$(COMPOSE) exec wallet-api npm run --silent migrate

migrate-rollback:
	$(COMPOSE) exec wallet-api npm run --silent migrate:rollback

migrate-status:
	$(COMPOSE) exec wallet-api npm run --silent migrate:status

migrate-fresh:
	$(COMPOSE) exec wallet-api npm run --silent migrate:fresh

migration:
	@test -n "$(name)" || (echo "usage: make migration name=create_x_table" && exit 1)
	$(COMPOSE) run --rm --no-deps -v $(CURDIR)/$(MIGRATIONS):/app/$(MIGRATIONS) wallet-api npm run --silent make:migration -- $(name)

# The editor reads node_modules and src/infra/generated from this folder; both are produced inside a
# container (same Node and protoc as the image), so nothing has to be installed on the host.
deps:
	docker run --rm -v "$(CURDIR)":/app -w /app node:26-alpine \
	  sh -c 'apk add --no-cache protobuf >/dev/null && npm ci --ignore-scripts --no-audit --no-fund && npm run --silent proto:gen'

TEST_COMPOSE = docker compose -f docker/docker-compose.test.yml

.env.test:
	cp .env.test.example .env.test

test: test-unit test-integration

test-unit: .env.test
	$(TEST_COMPOSE) run --rm --build --no-deps tests npm run --silent check

# The ephemeral containers are always removed, even when a test fails.
test-integration: .env.test
	@$(TEST_COMPOSE) run --rm --build tests; status=$$?; $(TEST_COMPOSE) down -v --remove-orphans >/dev/null 2>&1; exit $$status
