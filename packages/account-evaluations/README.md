# @stripe/radar-better-auth

Stripe [Account Evaluations](https://docs.stripe.com/radar/customer-account-evaluations) for Better Auth email/password signup and login.

## Install

Requires Node.js 22.13+ and Better Auth 1.7.x (1.7.7 or later). Use a secret key and publishable key from the same Stripe account that has access to the Account Evaluations API.

This package is unpublished. From the repository root, run `npm install` and `npm run pack`, then install the generated tarball from `build/` in your app:

```sh
npm install /path/to/package.tgz
```

## Configure

Server:

```ts
import { betterAuth } from "better-auth";
import { accountEvaluations } from "@stripe/radar-better-auth";

export const auth = betterAuth({
  database, // Your Better Auth database adapter.
  emailAndPassword: { enabled: true },
  plugins: [
    accountEvaluations({
      stripe: { secretKey: process.env.STRIPE_SECRET_KEY! },
      resolveCustomer: async (user) => yourCustomerResolutionFn(user),
    }),
  ],
});
```

Client:

```ts
import { createAuthClient } from "better-auth/react";
import { accountEvaluationsClient } from "@stripe/radar-better-auth/client";

export const authClient = createAuthClient({
  plugins: [
    accountEvaluationsClient({
      publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!,
    }),
  ],
});

await authClient.signUp.email({ email, name, password });
await authClient.signIn.email({ email, password });
```

Use your existing Better Auth handler.

## Customer setup

To evaluate logins, your app must create and store a Stripe Customer ID for each user. Implement `yourCustomerResolutionFn` in the example above to return that user's Customer ID, or `undefined` if none exists. Signup can be evaluated using email alone.

## Behavior

Signup checks for multiple-account abuse. Login checks for account sharing.

Attempts with risk scores of 75 or higher are blocked. Set `blockThreshold` to change that cutoff or `mode: "monitor"` to evaluate without blocking. If you're in monitor mode, you can check your Stripe Radar dashboard to analyze the results before moving to enforcement.

If a risk check cannot complete, normal authentication continues (`failureMode: "open"`, the default). Set `failureMode: "closed"` to reject those attempts.

## License

Licensed under the [MIT License](LICENSE).
