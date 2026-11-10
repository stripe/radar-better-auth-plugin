# Account Evaluations for Better Auth

Stripe account risk checks for Better Auth email/password signup and login, with a Next.js example.

See the [plugin README](packages/account-evaluations/README.md) for installation, integration, and behavior.

## Run the example

Requires Node.js 22.13+ and npm. The example uses SQLite and local mocks by default.

```sh
npm install
cp examples/nextjs/.env.example examples/nextjs/.env.local
# Replace BETTER_AUTH_SECRET with the output of: openssl rand -base64 32
npm run build -w @stripe/radar-better-auth
npm run db:migrate
npm run dev
```

Open http://localhost:3000. Use a password of at least 12 characters and one of these mock fixtures:

| Email                                | Score | Default result |
| ------------------------------------ | ----- | -------------- |
| `normal_scoring_email@example.com`   | 20    | Allowed        |
| `elevated_scoring_email@example.com` | 65    | Allowed        |
| `high_scoring_email@example.com`     | 80    | Blocked        |

Mock mode includes a local Customer mapping so signup and login work immediately. When using Stripe’s API, [configure a Customer mapping](packages/account-evaluations/README.md#customer-setup) before testing login; the example does not create Stripe Customers.

### Use Stripe’s API

In `examples/nextjs/.env.local`, set:

```dotenv
ACCOUNT_EVALUATIONS_MODE=stripe
DATABASE_PATH=./data/stripe-auth.db
STRIPE_SECRET_KEY=sk_test_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

Use test keys from the same Stripe account with access to the v2 Signals API. Run `npm run db:migrate` for the separate database, then restart. Rebuild production bundles after changing the publishable key.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution instructions and the Contributor License Agreement.

Run `npm test` and `npm run typecheck` locally.

For the optional [sandbox integration tests](tests/integration/stripe.ts), set the matching test keys above, run `npx playwright install chromium`, then `npm run test:stripe`. Results are saved to `test-results/live-stripe-results.json`.

## License

This project is licensed under the [MIT License](LICENSE).
