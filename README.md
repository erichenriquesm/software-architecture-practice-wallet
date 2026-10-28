# software-architecture-practice-wallet

Serviço `wallet` da [plataforma de trading](https://github.com/erichenriquesm/software-architecture-practice) (projeto de prática de arquitetura de software).

Carteira: depósito, saque, reserva de saldo para ordens abertas e liquidação das negociações, com ledger de auditoria.

## O que faz

Guarda o saldo de cada conta por ativo (disponível e reservado). Reserva o saldo quando uma ordem é criada (é o que impede gastar o mesmo saldo duas vezes), liquida cada negociação nos dois lados, libera o que não foi executado e compensa a saga quando a ordem é anulada.

A especificação completa (modelo, casos de uso, dados, testes) está na spec do serviço: [`sdd/services/wallet.md`](https://github.com/erichenriquesm/software-architecture-practice/blob/main/sdd/services/wallet.md). As regras de arquitetura valem para todos os serviços: [`sdd/01-principios.md`](https://github.com/erichenriquesm/software-architecture-practice/blob/main/sdd/01-principios.md).

## Comece por aqui

Uma reserva de saldo, de ponta a ponta:

1. `src/infra/messaging/consumers/orderPlacedConsumer.ts`: recebe `order.placed` do RabbitMQ.
2. `src/application/usecases/reserveFunds.ts`: decide quanto reservar e de qual ativo.
3. `src/domain/entities/wallet.ts`: a carteira, com as regras de saldo (disponível, reservado, ledger) e os eventos.
4. `src/infra/database/kyselyWalletRepository.ts`: grava saldo, reserva e ledger no Postgres.
5. `src/infra/messaging/walletIntegrationEvents.ts`: transforma os eventos em `wallet.fundsReserved` (ou `fundsReservationRejected`) e grava no outbox; o worker publica.

Depósito e saque seguem o mesmo caminho, a partir da rota em `src/infra/http/walletRoutes.ts`.

## API

| Rota | O que faz |
|---|---|
| `POST /deposit` | `204` · `404` conta · `422` ativo/quantidade · `409` · `503` |
| `POST /withdraw` | `204` · saldo reservado não é sacável |

**gRPC interno:** Servidor `WalletService.GetBalances` (só o `account` pode chamar). Cliente de `AccountService.Exists`.

## Eventos (RabbitMQ)

- **Publica:** `wallet.fundsReserved`, `wallet.fundsReservationRejected`, `wallet.balanceChanged`
- **Consome:** `account.created`, `order.placed`, `order.voided`, `matching.tradeExecuted`, `matching.orderRemoved`

Os contratos ficam em `src/infra/schemas/`: `published/` (este serviço é o dono) e `consumed/` (cópias do que ele consome, conferidas pelo `make check` do repositório guarda-chuva).

## Como rodar

Este serviço roda junto com a plataforma, a partir do [repositório guarda-chuva](https://github.com/erichenriquesm/software-architecture-practice), que tem a infra compartilhada (RabbitMQ, Redis, edge) e clona todos os serviços:

```bash
git clone https://github.com/erichenriquesm/software-architecture-practice.git
cd software-architecture-practice/backend
make clone
make up
```

Containers: `wallet-api` (REST + gRPC) · `wallet-worker` (cinco consumers + outbox) · `wallet-db`. Portas no host (só para depurar): REST 3002 · gRPC 50052 · Postgres 5434.

Dentro da pasta do serviço (`backend/wallet/`):

| Comando | O que faz |
|---|---|
| `make test` | typecheck, lint, regras de arquitetura, testes de unidade e de integração (tudo em container) |
| `make migrate` · `make migrate-status` · `make migrate-rollback` · `make migration name=...` | migrações no estilo Laravel |
| `make deps` | instala o `node_modules` na sua máquina, só para o editor |

## Estrutura

```
src/
  domain/        regras de negócio (entities, valueObjects, events)
  application/   casos de uso, DTOs e contratos (interfaces)
  infra/         HTTP, mensageria, banco, plataforma técnica, schemas de eventos
test/
  unit/  integration/  fakes/  support/
docker/          Dockerfile e composes (só para ambiente local)
```
