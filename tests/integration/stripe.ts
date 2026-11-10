import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import Stripe from "stripe";
import { STRIPE_API_VERSION } from "../../packages/account-evaluations/src/stripe.js";
import {
  accountEvaluations,
  createStripeAccountEvaluationsClient,
  type AccountReference,
  type AccountEvaluationsClient,
  type DecisionReport,
  type Evaluation,
} from "../../packages/account-evaluations/src/index.js";

const secretKey = process.env.STRIPE_SECRET_KEY;
const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
if (
  !secretKey?.startsWith("sk_test_") ||
  !publishableKey?.startsWith("pk_test_")
) {
  throw new Error(
    "Sandbox integration tests require matching sk_test_ and pk_test_ keys in examples/nextjs/.env.local. Live-mode keys are rejected.",
  );
}

const stripeSdk = new Stripe(secretKey, {
  timeout: 15_000,
  maxNetworkRetries: 0,
});
const stripe = createStripeAccountEvaluationsClient({
  secretKey,
  stripeClient: stripeSdk,
});
const customers = new Set<string>();
const evaluations: Array<Evaluation & AccountReference & { activity: string }> =
  [];
const reports: DecisionReport[] = [];
const failures: string[] = [];
const outcomes: Array<{ name: string; passed: boolean; details?: string }> = [];
const client: AccountEvaluationsClient = {
  async evaluate(input) {
    const result = await stripe.evaluate(input);
    evaluations.push({
      ...result,
      ...(input.customerId
        ? { customerId: input.customerId }
        : { contactEmail: input.contactEmail! }),
      activity: input.activity,
    });
    return result;
  },
  async reportDecision(report) {
    await stripe.reportDecision(report);
    reports.push(report);
  },
};

type RadarWindow = Window & {
  collectRadarSession: (key: string) => Promise<string | undefined>;
};

async function radarSession(page: Page) {
  const id = await page.evaluate(async (key) => {
    return (window as unknown as RadarWindow).collectRadarSession(key);
  }, publishableKey!);
  assert.ok(
    typeof id === "string" && id.startsWith("rse_"),
    "The client plugin did not attach a Radar Session.",
  );
  return id;
}

async function runCase(name: string, work: () => Promise<void>) {
  try {
    await work();
    outcomes.push({ name, passed: true });
    console.info(`PASS ${name}`);
  } catch (error) {
    const details =
      error instanceof Stripe.errors.StripeError
        ? `${error.message} HTTP ${error.statusCode ?? "network"}, request ${error.requestId ?? "unavailable"}`
        : error instanceof Error
          ? error.message
          : "Unknown failure";
    failures.push(name);
    outcomes.push({ name, passed: false, details });
    console.error(`FAIL ${name}: ${details}`);
  }
}

const server = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(
    "<!doctype html><html lang='en'><head><title>Account Evaluations sandbox test</title></head><body>Collecting test device context.</body></html>",
  );
});
let browser: Browser | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(`http://127.0.0.1:${address.port}`);
  // Forward real browser Radar tokens to the Better Auth handler.
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(
        new URL("../../packages/account-evaluations/", import.meta.url),
      ),
      contents: `
        import { createAuthClient } from "better-auth/client";
        import { accountEvaluationsClient } from "./src/client.ts";
        let client;
        window.collectRadarSession = async (publishableKey) => {
          client ??= createAuthClient({
            baseURL: window.location.origin,
            plugins: [accountEvaluationsClient({ publishableKey, timeoutMs: 30000 })],
            fetchOptions: { customFetchImpl: async (_url, init) => Response.json({
              radarSession: new Headers(init.headers).get("x-stripe-radar-session"),
            }) },
          });
          const result = await client.signIn.email({ email: "test@example.com", password: "test-only-password" });
          if (result.error) throw new Error("Client request failed");
          return result.data.radarSession;
        };
      `,
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
  });
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });

  for (const fixture of [
    { label: "normal", email: "normal_scoring_email@example.com", score: 20 },
    {
      label: "elevated",
      email: "elevated_scoring_email@example.com",
      score: 65,
    },
    { label: "highest", email: "high_scoring_email@example.com", score: 80 },
  ]) {
    const database: Record<string, Array<Record<string, unknown>>> = {
      user: [],
      account: [],
      session: [],
      verification: [],
    };
    const customerByEmail = new Map<string, string>();
    const makeAuth = (mode: "enforce" | "monitor") =>
      betterAuth({
        baseURL: "http://localhost:3000",
        secret: "sandbox-integration-tests-only-at-least-32-characters",
        database: memoryAdapter(database),
        emailAndPassword: { enabled: true },
        rateLimit: { enabled: false },
        logger: { disabled: true },
        plugins: [
          accountEvaluations({
            client,
            mode,
            async resolveCustomer(user) {
              const existingCustomer = customerByEmail.get(user.email);
              if (existingCustomer) return existingCustomer;
              const referenceId = user.id ?? randomUUID();
              const customer = await stripeSdk.customers.create(
                {
                  email: user.email,
                  name: user.name,
                  metadata: { better_auth_reference: referenceId },
                },
                { idempotencyKey: `ba-customer-${referenceId}` },
              );
              customers.add(customer.id);
              customerByEmail.set(user.email, customer.id);
              return customer.id;
            },
            onError({ error }) {
              if (error instanceof Stripe.errors.StripeError)
                console.error(
                  `Stripe failure: HTTP ${error.statusCode ?? "network"}, request ${error.requestId ?? "unavailable"}`,
                );
            },
          }),
        ],
      });
    const auth = makeAuth("enforce");
    const request = async (target: typeof auth, path: string) =>
      target.handler(
        new Request(`http://localhost:3000/api/auth/${path}/email`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:3000",
            "x-stripe-radar-session": await radarSession(page),
          },
          body: JSON.stringify({
            name: "Account Evaluations Sandbox Test",
            email: fixture.email,
            password: "sandbox-test-password-123",
          }),
        }),
      );
    let signupCustomer: string | undefined;
    await runCase(
      `${fixture.label}: registration score and ${fixture.score >= 75 ? "blocked" : "allowed"} outcome`,
      async () => {
        const previousReports = reports.length;
        const response = await request(auth, "sign-up");
        const body = await response.json();
        assert.equal(
          response.status,
          fixture.score >= 75 ? 403 : 200,
          `Unexpected registration HTTP ${response.status}: ${body.code ?? "no error code"}`,
        );
        const evaluation = evaluations.at(-1);
        assert.equal(evaluation?.score, fixture.score);
        assert.equal(evaluation?.signal, "user_multi_accounting");
        assert.equal(
          reports.length,
          previousReports + 1,
          "Decision report did not reach Stripe.",
        );
        assert.equal(
          reports.at(-1)?.status,
          fixture.score >= 75 ? "blocked" : "allowed",
        );
        assert.equal(database.user!.length, fixture.score >= 75 ? 0 : 1);
        assert.equal(database.session!.length, fixture.score >= 75 ? 0 : 1);
        signupCustomer = evaluation!.customerId;
      },
    );
    if (fixture.score >= 75) {
      await runCase(
        "highest: monitor mode creates the account and reports allowed",
        async () => {
          const previousReports = reports.length;
          const response = await request(makeAuth("monitor"), "sign-up");
          assert.equal(response.status, 200);
          assert.equal(evaluations.at(-1)?.score, 80);
          assert.equal(reports.length, previousReports + 1);
          assert.equal(reports.at(-1)?.status, "allowed");
          signupCustomer = evaluations.at(-1)!.customerId;
        },
      );
    }
    await runCase(
      `${fixture.label}: login score, customer reuse, and ${fixture.score >= 75 ? "blocked" : "allowed"} outcome`,
      async () => {
        const previousReports = reports.length;
        const previousCustomers = customers.size;
        const previousSessions = database.session!.length;
        const response = await request(auth, "sign-in");
        const body = await response.json();
        assert.equal(
          response.status,
          fixture.score >= 75 ? 403 : 200,
          `Unexpected login HTTP ${response.status}: ${body.code ?? "no error code"}`,
        );
        assert.equal(evaluations.at(-1)?.score, fixture.score);
        assert.equal(evaluations.at(-1)?.signal, "user_account_sharing");
        assert.equal(evaluations.at(-1)?.customerId, signupCustomer);
        assert.equal(customers.size, previousCustomers);
        assert.equal(
          reports.length,
          previousReports + 1,
          "Decision report did not reach Stripe.",
        );
        assert.equal(
          reports.at(-1)?.status,
          fixture.score >= 75 ? "blocked" : "allowed",
        );
        assert.equal(
          database.session!.length,
          previousSessions + (fixture.score >= 75 ? 0 : 1),
        );
        if (fixture.score >= 75)
          assert.equal(response.headers.get("set-cookie"), null);
      },
    );
  }
} catch (error) {
  failures.push("setup");
  const details =
    error instanceof Error ? error.message : "Unknown setup failure";
  outcomes.push({ name: "setup", passed: false, details });
  console.error(`FAIL setup: ${details}`);
} finally {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const customer of customers) {
    try {
      await stripeSdk.customers.del(customer);
    } catch {
      failures.push(`cleanup ${customer}`);
      console.error(
        `Could not delete test customer ${customer}; remove it from your sandbox manually.`,
      );
    }
  }
  const outputDirectory = new URL("../../test-results/", import.meta.url);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    new URL("live-stripe-results.json", outputDirectory),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        apiVersion: STRIPE_API_VERSION,
        outcomes,
        evaluations,
        reports,
        failures,
      },
      null,
      2,
    ),
  );
  console.info(
    `Results: ${fileURLToPath(new URL("live-stripe-results.json", outputDirectory))}`,
  );
  process.exitCode = failures.length ? 1 : 0;
}
