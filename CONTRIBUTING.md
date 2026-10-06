# Contributing

This repository releases independently of `dskt-frontend` and the setup workspace.

- Use conventional commits.
- Keep changes small and covered by the lowest useful test.
- Change the database only through a forward Drizzle migration.
- Regenerate `contract/openapi.json` when routes change, and keep responses free of secrets and connection details.
- Do not commit `.env` files or production credentials.
- Run `npm run format`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run openapi:check` before opening a pull request.

`drizzle-kit` is a development dependency. Production images install runtime dependencies only and run as a non-root user.
