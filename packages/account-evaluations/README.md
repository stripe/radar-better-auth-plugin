# @stripe/radar-better-auth

Stripe [Account Evaluations](https://docs.stripe.com/radar/customer-account-evaluations) for Better Auth email/password and social signup and login.

## Install

Requires Node.js 22.13+ and Better Auth 1.7.x (1.7.7 or later). Use a secret key and publishable key from the same Stripe account that has access to the Account Evaluations API.

```sh
npm install @stripe/radar-better-auth
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

## Social providers

Configure your providers using Better Auth's [social sign-in documentation](https://www.better-auth.com/docs/concepts/oauth), and keep the same server and client plugins shown above. For example, add Google to your server configuration:

```ts
socialProviders: {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  },
},
```

Then initiate sign-in through the Better Auth client:

```ts
await authClient.signIn.social({
  provider: "google",
  callbackURL: "/dashboard",
  errorCallbackURL: "/login",
});
```

The client collects a Radar Session before redirecting. The server carries the device evidence in Better Auth's protected OAuth state and evaluates the verified provider identity on `/callback/:id`. A new user receives a registration check before creation; an existing user receives a login check before session creation. The first signup is evaluated once, even though it also creates a session.

Direct `signIn.social({ provider, idToken: { token } })` requests are also supported when the configured provider supports ID-token sign-in. Better Auth verifies the token before the risk check.

Redirect-based blocks go to your `errorCallbackURL` with `error=ACCOUNT_EVALUATION_BLOCKED`; ID-token requests return the normal API error. Evaluation failures follow `failureMode` for both flows. If browser collection fails, the server preserves the initiating request's IP-based fallback, subject to your Better Auth IP configuration.

This covers Better Auth's built-in social sign-in routes. Explicit account linking, generic OAuth/SSO plugins, and custom callback routes are outside this integration. The bundled Next.js example continues to demonstrate email/password authentication.

## Customer setup

To evaluate logins, your app must create and store a Stripe Customer ID for each user. Implement `yourCustomerResolutionFn` in the example above to return that user's Customer ID, or `undefined` if none exists. Signup can be evaluated using email alone.

## Behavior

Signup checks for multiple-account abuse. Login checks for account sharing.

Attempts with risk scores of 75 or higher are blocked. Set `blockThreshold` to change that cutoff or `mode: "monitor"` to evaluate without blocking. If you're in monitor mode, you can check your Stripe Radar dashboard to analyze the results before moving to enforcement.

If a risk check cannot complete, normal authentication continues (`failureMode: "open"`, the default). Set `failureMode: "closed"` to reject those attempts.

## License

Licensed under the [MIT License](LICENSE).
