import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { accountEvaluations } from "@stripe/radar-better-auth";
import { mockStripe, resolveMockCustomer } from "./mock-stripe";

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `Set ${name} in examples/nextjs/.env.local. See .env.example.`,
    );
  return value;
}

const mode = required("ACCOUNT_EVALUATIONS_MODE");
if (mode !== "mock" && mode !== "stripe")
  throw new Error("ACCOUNT_EVALUATIONS_MODE must be mock or stripe.");
const policy = process.env.ACCOUNT_EVALUATIONS_POLICY ?? "enforce";
if (policy !== "enforce" && policy !== "monitor")
  throw new Error("ACCOUNT_EVALUATIONS_POLICY must be enforce or monitor.");

const databasePath = resolve(process.env.DATABASE_PATH ?? "./data/auth.db");
mkdirSync(dirname(databasePath), { recursive: true });
const globalForDatabase = globalThis as typeof globalThis & {
  exampleDatabase?: Database.Database;
};
export const database =
  globalForDatabase.exampleDatabase ?? new Database(databasePath);
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");
if (process.env.NODE_ENV !== "production")
  globalForDatabase.exampleDatabase = database;

export const auth = betterAuth({
  appName: "Account Evaluations Example",
  baseURL: required("BETTER_AUTH_URL"),
  secret: required("BETTER_AUTH_SECRET"),
  database,
  emailAndPassword: { enabled: true, minPasswordLength: 12 },
  rateLimit: { enabled: true, storage: "database" },
  plugins: [
    accountEvaluations({
      ...(mode === "mock"
        ? { client: mockStripe, resolveCustomer: resolveMockCustomer }
        : {
            stripe: {
              secretKey: required("STRIPE_SECRET_KEY"),
            },
          }),
      mode: policy,
      blockThreshold: 75,
      onDecision(event) {
        console.info("[account-evaluations]", {
          evaluationId: event.evaluationId,
          activity: event.activity,
          score: event.evaluation.score,
          status: event.status,
          reported: event.reported,
        });
      },
      onError({ operation, error, report }) {
        console.error(`[account-evaluations] ${operation} failed`, {
          message:
            error instanceof Error
              ? error.message.replace(
                  /\b(?:[spr]k_(?:test|live)_|whsec_)[a-zA-Z0-9_*]+/g,
                  "[REDACTED]",
                )
              : "Unknown error",
          statusCode:
            error instanceof Error &&
            "statusCode" in error &&
            typeof error.statusCode === "number"
              ? error.statusCode
              : undefined,
          requestId:
            error instanceof Error &&
            "requestId" in error &&
            typeof error.requestId === "string"
              ? error.requestId
              : undefined,
          ...(report
            ? { evaluationId: report.evaluationId, status: report.status }
            : {}),
        });
      },
    }),
  ],
});
