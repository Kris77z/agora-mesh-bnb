# PostgreSQL multi-replica backend

This directory is the local acceptance environment for ADR-009. It validates
multiple application replicas sharing PostgreSQL; it is not a claim that one
Docker container provides database high availability.

Local URLs (development credentials only):

- migration: `postgresql://agora_migrator:agora_migrator_local@127.0.0.1:55432/agora_mesh`
- runtime: `postgresql://agora_runtime:agora_runtime_local@127.0.0.1:55432/agora_mesh`

Commands:

```bash
npm run db:up
npm run db:migrate
npm run test:postgres
npm run db:down
```

`db:down` keeps the named development volume. Use the explicit
`npm run db:reset` command only when the local Agora Mesh database may be erased.

Production requirements remain: PostgreSQL 15+, TLS, separate migration/runtime
roles, managed failover or Patroni equivalent, daily backup plus PITR, connection
pool budgets, and alerts for locks, replication lag, outbox backlog and uncertain
settlements. No production endpoint is encoded in these files.
