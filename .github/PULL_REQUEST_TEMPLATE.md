## Summary

<!-- What does this change and why? -->

Closes #<!-- issue number -->

## Testing

<!-- How was this verified? Paste the commands you ran and their results. -->

- [ ] `npm run test:fast` passes
- [ ] `npm run build` passes
- [ ] Tests added or updated for the new behavior
- [ ] `npm run test:live` run, if this touches Horizon, Friendbot or Soroban flows

## Database and configuration

- [ ] No migration, **or** a migration in `db/` that is reversible (`migrate:down` works), described below
- [ ] No new environment variable, **or** it's documented in `README.md` and `.env.example`

<!-- Migration / env notes: -->

## Breaking changes

- [ ] None, **or** described below (API response shapes, endpoints, env vars, money rules)

<!-- Breaking-change notes: -->

## Checklist

- [ ] Scoped to the linked issue (see `CONTRIBUTING.md`)
- [ ] Comments follow `docs/specs/07-comment-style.md`
- [ ] No secrets, tokens or real customer data in code, tests or logs
