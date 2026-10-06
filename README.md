# dskt-backend

Independent DSKT API. This repository owns the OpenAPI contract, Drizzle migrations, and PostgreSQL access.

The current slice reports process liveness and database readiness. It does not implement product workflows.

## Commands

```bash
npm ci
npm run dev          # requires DATABASE_URL and CORS_ORIGIN
npm run migrate
npm test             # integration tests need DATABASE_URL
npm run lint
npm run format
npm run typecheck
npm run build
npm run openapi:generate
npm run openapi:check
```

Copy `.env.example` to `.env` for local process runs. The values there are local bootstrap placeholders, not production credentials.

From the setup workspace, `docker compose up --build` starts this service with PostgreSQL. The container applies migrations before listening and runs as the non-root `node` user. Missing or invalid configuration exits before the process listens.

## Contract

`contract/openapi.json` is generated from the routes. Regenerate it with `npm run openapi:generate` and commit the result. The frontend pins a copy of that file and generates its client from the pin.

## Health

- `GET /health/live` — the process can serve. It does not contact PostgreSQL.
- `GET /health/ready` — PostgreSQL accepted `select 1`. Failure returns `503` and `{ "status": "not_ready" }` with no connection details.

## Layout

Domain modules will follow the architecture in the setup repository. This slice only has platform configuration, migrations, and health routes.
