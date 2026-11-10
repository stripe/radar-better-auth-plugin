import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// Keep this suite runnable before a build; test:package checks the built exports.
vi.mock(
  "@stripe/radar-better-auth",
  () => import("../../packages/account-evaluations/src/index"),
);

const directory = mkdtempSync(join(tmpdir(), "account-evaluations-example-"));
const baseURL = "http://localhost:3000";
const password = "example-test-password-123";
let app: typeof import("../../examples/nextjs/lib/auth");

beforeAll(async () => {
  vi.stubEnv("ACCOUNT_EVALUATIONS_MODE", "mock");
  vi.stubEnv("ACCOUNT_EVALUATIONS_POLICY", "enforce");
  vi.stubEnv("BETTER_AUTH_URL", baseURL);
  vi.stubEnv(
    "BETTER_AUTH_SECRET",
    "local-example-test-secret-at-least-32-characters",
  );
  vi.stubEnv("DATABASE_PATH", join(directory, "auth.db"));
  app = await import("../../examples/nextjs/lib/auth");
  await (await getMigrations(app.auth.options)).runMigrations();
});

afterAll(() => {
  app?.database.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

async function request(path: string, body?: object, cookie = "") {
  return app.auth.handler(
    new Request(`${baseURL}/api/auth/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        origin: baseURL,
        "x-stripe-radar-session": "rse_exampletest",
        "x-forwarded-for": "203.0.113.10",
        ...(cookie ? { cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

it("the example supports signup, session lookup, logout, and login in mock mode", async () => {
  const email = "normal_scoring_email@example.com";
  const signup = await request("sign-up/email", {
    name: "Example Test",
    email,
    password,
  });
  expect(signup.status).toBe(200);
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  expect(
    await (await request("get-session", undefined, cookie)).json(),
  ).toMatchObject({ user: { email } });
  expect((await request("sign-out", {}, cookie)).status).toBe(200);
  expect(
    await (await request("get-session", undefined, cookie)).json(),
  ).toBeNull();
  const login = await request("sign-in/email", { email, password });
  expect(login.status).toBe(200);
  expect(await login.json()).toMatchObject({ user: { email } });
});

it("the mock Customer mapping preserves high-risk blocking before creating a user", async () => {
  const email = "high_scoring_email@example.com";
  const response = await request("sign-up/email", {
    name: "Blocked Test",
    email,
    password,
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: "ACCOUNT_EVALUATION_BLOCKED",
  });
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(
    app.database.prepare('SELECT id FROM "user" WHERE email = ?').get(email),
  ).toBeUndefined();
});
