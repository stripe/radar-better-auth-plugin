import { describe, expect, it, vi } from "vitest";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthClient } from "better-auth/client";
import { APIError } from "better-auth/api";
import Stripe from "stripe";
import {
  accountEvaluations,
  type AccountEvaluationsConfig,
  type AccountEvaluationsClient,
} from "../src/index.js";
import { accountEvaluationsClient } from "../src/client.js";

const password = "correct-horse-battery-staple";

function setup(
  config: Partial<AccountEvaluationsConfig> = {},
  authOptions: Partial<BetterAuthOptions> = {},
) {
  const db: Record<string, Array<Record<string, unknown>>> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  let score = 20;
  const client = {
    evaluate: vi
      .fn<AccountEvaluationsClient["evaluate"]>()
      .mockImplementation(async ({ activity }) => ({
        id: "acctevl_test123",
        signal:
          activity === "registration"
            ? "user_multi_accounting"
            : "user_account_sharing",
        score,
        riskLevel:
          score >= 75 ? "highest" : score >= 65 ? "elevated" : "normal",
      })),
    reportDecision: vi
      .fn<AccountEvaluationsClient["reportDecision"]>()
      .mockResolvedValue(undefined),
  };
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "test-only-secret-with-at-least-32-characters",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
    ...authOptions,
    plugins: [
      accountEvaluations({ client, ...config } as AccountEvaluationsConfig),
    ],
  });
  async function request(
    path: string,
    body: object,
    radar: string | null = "rse_test123",
    additionalHeaders: Record<string, string> = {},
  ) {
    return auth.handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
          ...(radar ? { "x-stripe-radar-session": radar } : {}),
          ...additionalHeaders,
        },
        body: JSON.stringify(body),
      }),
    );
  }
  const signup = (
    email = "user@example.com",
    radar: string | null = "rse_test123",
  ) => request("/sign-up/email", { name: "Test User", email, password }, radar);
  const login = (pw = password) =>
    request("/sign-in/email", { email: "user@example.com", password: pw });
  return {
    auth,
    db,
    client,
    request,
    signup,
    login,
    setScore: (value: number) => {
      score = value;
    },
  };
}

describe("Better Auth integration", () => {
  it("does not report allowed if another hook rejects authentication after evaluation", async () => {
    const app = setup(
      {},
      {
        databaseHooks: {
          session: {
            create: {
              before: async () => {
                throw new APIError("FORBIDDEN", {
                  message: "Application access denied",
                });
              },
            },
          },
        },
      },
    );
    expect((await app.signup()).status).toBe(403);
    expect(app.client.evaluate).toHaveBeenCalledTimes(1);
    expect(app.client.reportDecision).not.toHaveBeenCalled();
  });

  it("uses a resolved customer without adding a field to the user", async () => {
    const app = setup({ resolveCustomer: async () => "cus_existing" });
    const signup = await app.signup();
    expect(signup.status).toBe(200);
    expect(app.db.user![0]).not.toHaveProperty("stripeCustomerId");
    expect((await signup.json()).user).not.toHaveProperty("stripeCustomerId");
    expect(app.client.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus_existing" }),
    );
    expect(app.client.reportDecision).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus_existing" }),
    );
  });

  it.each(["fails", "times out"])(
    "uses trusted sessionless details when browser collection %s",
    async (outcome) => {
      const app = setup();
      const browser = createAuthClient({
        baseURL: "http://localhost:3000",
        fetchOptions: {
          customFetchImpl: (url, init) =>
            app.auth.handler(new Request(url, init)),
          headers: {
            "x-stripe-radar-session": "rse_stale",
            "x-forwarded-for": "203.0.113.10",
          },
        },
        plugins: [
          accountEvaluationsClient({
            createRadarSession: () =>
              outcome === "fails"
                ? Promise.reject(new Error("collection failed"))
                : new Promise(() => {}),
            timeoutMs: 5,
          }),
        ],
      });
      expect(
        (
          await browser.signUp.email({
            name: "Test",
            email: "user@example.com",
            password,
          })
        ).error,
      ).toBeNull();
      expect(app.client.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          clientDetails: { data: { ip: "203.0.113.10" } },
        }),
      );
    },
  );

  it("uses entityless registration when no existing customer resolves", async () => {
    const app = setup();
    const signup = await app.signup();
    expect(signup.status).toBe(200);
    expect(app.db.user).toHaveLength(1);
    expect(app.db.user![0]!.stripeCustomerId).toBeUndefined();
    expect((await signup.json()).user).not.toHaveProperty("stripeCustomerId");
    expect(app.client.reportDecision).toHaveBeenLastCalledWith({
      contactEmail: "user@example.com",
      evaluationId: "acctevl_test123",
      activity: "registration",
      status: "allowed",
    });
  });

  it.each([undefined, "closed", "open"] as const)(
    "uses the %s failure policy for login without a Customer, without calling Stripe",
    async (failureMode) => {
      const app = setup({ failureMode });
      await app.signup();
      app.client.evaluate.mockClear();
      app.client.reportDecision.mockClear();
      const sessionCount = app.db.session!.length;
      const login = await app.login();
      expect(login.status).toBe(failureMode === "closed" ? 503 : 200);
      expect(app.db.session).toHaveLength(
        sessionCount + (failureMode !== "closed" ? 1 : 0),
      );
      if (failureMode === "closed") {
        expect(await login.json()).toMatchObject({
          code: "ACCOUNT_EVALUATION_UNAVAILABLE",
        });
        expect(login.headers.get("set-cookie")).toBeNull();
      }
      expect(app.client.evaluate).not.toHaveBeenCalled();
      expect(app.client.reportDecision).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "closed", "open"] as const)(
    "uses the %s policy when browser collection fails and IP tracking is disabled",
    async (failureMode) => {
      const app = setup(
        { failureMode },
        { advanced: { ipAddress: { disableIpTracking: true } } },
      );
      const browser = createAuthClient({
        baseURL: "http://localhost:3000",
        fetchOptions: {
          customFetchImpl: (url, init) =>
            app.auth.handler(new Request(url, init)),
          headers: { "x-forwarded-for": "203.0.113.10" },
        },
        plugins: [
          accountEvaluationsClient({
            createRadarSession: async () => {
              throw new Error("collection failed");
            },
          }),
        ],
      });
      const result = await browser.signUp.email({
        name: "Test",
        email: "user@example.com",
        password,
      });
      if (failureMode !== "closed") expect(result.error).toBeNull();
      else expect(result.error?.status).toBe(400);
      expect(app.client.evaluate).not.toHaveBeenCalled();
      expect(app.client.reportDecision).not.toHaveBeenCalled();
      expect(app.db.user).toHaveLength(failureMode !== "closed" ? 1 : 0);
      expect(app.db.session).toHaveLength(failureMode !== "closed" ? 1 : 0);
    },
  );

  it.each([undefined, "closed", "open"] as const)(
    "blocks high-risk signup before creating a user or session under the %s failure policy",
    async (failureMode) => {
      const app = setup({ failureMode });
      app.setScore(80);
      const result = await app.signup();
      expect(result.status).toBe(403);
      expect(await result.json()).toMatchObject({
        code: "ACCOUNT_EVALUATION_BLOCKED",
      });
      expect(app.db.user).toHaveLength(0);
      expect(app.db.account).toHaveLength(0);
      expect(app.db.session).toHaveLength(0);
      expect(result.headers.get("set-cookie")).toBeNull();
      expect(app.client.reportDecision).toHaveBeenCalledExactlyOnceWith({
        contactEmail: "user@example.com",
        evaluationId: "acctevl_test123",
        activity: "registration",
        status: "blocked",
      });
    },
  );

  it.each([undefined, "closed", "open"] as const)(
    "blocks high-risk login before issuing a session under the %s failure policy",
    async (failureMode) => {
      const app = setup({
        failureMode,
        resolveCustomer: async () => "cus_existing",
      });
      await app.signup();
      app.setScore(80);
      const count = app.db.session!.length;
      const result = await app.login();
      expect(result.status).toBe(403);
      expect(app.db.session).toHaveLength(count);
      expect(result.headers.get("set-cookie")).toBeNull();
      expect(app.client.reportDecision).toHaveBeenLastCalledWith(
        expect.objectContaining({ activity: "login", status: "blocked" }),
      );
    },
  );

  it.each([undefined, "closed", "open"] as const)(
    "rejects invalid credentials and auth input under the %s failure policy",
    async (failureMode) => {
      const app = setup({ failureMode });
      expect((await app.login()).status).toBe(401);
      expect(
        (
          await app.request("/sign-up/email", {
            name: "Test",
            email: "invalid",
            password,
          })
        ).status,
      ).toBe(400);
      await app.signup();
      expect((await app.signup()).status).toBe(422);
      expect((await app.login("incorrect-password")).status).toBe(401);
      expect(app.client.evaluate).toHaveBeenCalledTimes(1);
      expect(app.client.reportDecision).toHaveBeenCalledTimes(1);
    },
  );

  describe.each([undefined, "closed", "open"] as const)(
    "device failures with failureMode: %s",
    (failureMode) => {
      it.each([
        { path: "/sign-up/email", radar: null, code: "RADAR_SESSION_REQUIRED" },
        { path: "/sign-in/email", radar: null, code: "RADAR_SESSION_REQUIRED" },
        {
          path: "/sign-up/email",
          radar: "invalid",
          code: "INVALID_RADAR_SESSION",
        },
        {
          path: "/sign-in/email",
          radar: "invalid",
          code: "INVALID_RADAR_SESSION",
        },
        {
          path: "/sign-up/email",
          radar: "rse_",
          code: "INVALID_RADAR_SESSION",
        },
        {
          path: "/sign-in/email",
          radar: "rse_",
          code: "INVALID_RADAR_SESSION",
        },
      ])(
        "$path handles $code ($radar) before creating a session",
        async ({ path, radar, code }) => {
          const resolveCustomer = vi.fn().mockResolvedValue("cus_existing");
          const onError = vi.fn();
          const onDecision = vi.fn();
          const app = setup(
            { failureMode, resolveCustomer, onError, onDecision },
            { advanced: { ipAddress: { disableIpTracking: radar === null } } },
          );
          if (path === "/sign-in/email")
            expect((await app.signup()).status).toBe(200);
          app.client.evaluate.mockClear();
          app.client.reportDecision.mockClear();
          resolveCustomer.mockClear();
          onDecision.mockClear();
          const sessionCount = app.db.session!.length;
          const result = await app.request(
            path,
            { name: "Test", email: "user@example.com", password },
            radar,
            radar ? { "x-forwarded-for": "203.0.113.10" } : {},
          );
          expect(result.status).toBe(failureMode !== "closed" ? 200 : 400);
          expect(app.db.session).toHaveLength(
            sessionCount + (failureMode !== "closed" ? 1 : 0),
          );
          if (failureMode !== "closed") {
            expect(await result.json()).toMatchObject({
              user: { email: "user@example.com" },
            });
            expect(result.headers.get("set-cookie")).toContain("session_token");
            const cookie = result.headers
              .getSetCookie()
              .map((value) => value.split(";")[0])
              .join("; ");
            const session = await app.auth.handler(
              new Request("http://localhost:3000/api/auth/get-session", {
                headers: { cookie },
              }),
            );
            expect(await session.json()).toMatchObject({
              user: { email: "user@example.com" },
            });
          } else {
            expect(await result.json()).toMatchObject({ code });
            expect(result.headers.get("set-cookie")).toBeNull();
            if (path === "/sign-up/email") {
              expect(app.db.user).toHaveLength(0);
              expect(app.db.account).toHaveLength(0);
            }
          }
          expect(onError).toHaveBeenCalledExactlyOnceWith({
            operation: "evaluation",
            error: expect.objectContaining({
              body: expect.objectContaining({ code }),
            }),
          });
          expect(resolveCustomer).not.toHaveBeenCalled();
          expect(app.client.evaluate).not.toHaveBeenCalled();
          expect(app.client.reportDecision).not.toHaveBeenCalled();
          expect(onDecision).not.toHaveBeenCalled();
        },
      );
    },
  );

  it.each([undefined, "closed", "open"] as const)(
    "uses the %s policy when Stripe returns a 400 during login",
    async (failureMode) => {
      const app = setup({
        failureMode,
        resolveCustomer: async () => "cus_existing",
      });
      expect((await app.signup()).status).toBe(200);
      app.client.reportDecision.mockClear();
      app.client.evaluate.mockRejectedValue(
        new Stripe.errors.StripeInvalidRequestError({
          type: "invalid_request_error",
          message: "Invalid device data",
          statusCode: 400,
        }),
      );
      const sessionCount = app.db.session!.length;
      const response = await app.login();
      expect(response.status).toBe(failureMode !== "closed" ? 200 : 503);
      expect(app.db.session).toHaveLength(
        sessionCount + (failureMode !== "closed" ? 1 : 0),
      );
      expect(response.headers.has("set-cookie")).toBe(failureMode !== "closed");
      expect(app.client.reportDecision).not.toHaveBeenCalled();
    },
  );

  it("derives sessionless details using Better Auth's configured headers and proxies", async () => {
    const app = setup(
      { resolveCustomer: async () => "cus_existing" },
      {
        advanced: {
          ipAddress: {
            ipAddressHeaders: ["x-client-ip"],
            trustedProxies: ["192.0.2.10"],
          },
        },
      },
    );
    const headers = {
      "x-forwarded-for": "198.51.100.99",
      "x-client-ip": "198.51.100.50, 203.0.113.10, 192.0.2.10",
      "user-agent": "test-agent",
      referer: "https://example.com/register",
    };
    expect(
      (
        await app.request(
          "/sign-up/email",
          { name: "Test User", email: "user@example.com", password },
          null,
          headers,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          "/sign-in/email",
          { email: "user@example.com", password },
          null,
          headers,
        )
      ).status,
    ).toBe(200);
    expect(app.client.evaluate).toHaveBeenCalledTimes(2);
    for (const activity of ["registration", "login"]) {
      expect(app.client.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          activity,
          clientDetails: {
            data: {
              ip: "203.0.113.10",
              user_agent: "test-agent",
              referrer: "https://example.com/register",
            },
          },
        }),
      );
    }
  });

  it("allows service errors by default and requires opt-in to fail closed", async () => {
    const closed = setup({ failureMode: "closed" });
    closed.client.evaluate.mockRejectedValue(new Error("offline"));
    expect((await closed.signup()).status).toBe(503);
    expect(closed.db.user).toHaveLength(0);
    expect(closed.client.reportDecision).not.toHaveBeenCalled();
    const open = setup();
    open.client.evaluate.mockRejectedValue(new Error("offline"));
    expect((await open.signup()).status).toBe(200);
    expect(open.db.user![0]!.stripeCustomerId).toBeUndefined();
    expect(open.client.reportDecision).not.toHaveBeenCalled();
  });

  it("observes high scores in monitor mode and reports the actual allowed decision", async () => {
    const onDecision = vi.fn();
    const app = setup({ mode: "monitor", onDecision });
    app.setScore(80);
    expect((await app.signup()).status).toBe(200);
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "allowed",
        reported: true,
        evaluation: expect.objectContaining({ score: 80 }),
      }),
    );
  });

  it.each([74.9, 75])(
    "enforces the configured boundary at score %s",
    async (score) => {
      const app = setup();
      app.setScore(score);
      expect((await app.signup()).status).toBe(score < 75 ? 200 : 403);
    },
  );

  it("reporting or observer failures cannot turn a block into an allow or break successful authentication", async () => {
    const onError = vi.fn().mockRejectedValue(new Error("logger down"));
    const app = setup({
      onError,
      resolveCustomer: async () => "cus_existing",
      onDecision: async () => {
        throw new Error("observer down");
      },
    });
    app.client.reportDecision.mockRejectedValue(new Error("Stripe down"));
    expect((await app.signup()).status).toBe(200);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "report",
        report: expect.objectContaining({ status: "allowed" }),
      }),
    );
    app.setScore(80);
    expect((await app.login()).status).toBe(403);
  });

  it("reports registration success when auto-sign-in is disabled", async () => {
    const app = setup(
      {},
      { emailAndPassword: { enabled: true, autoSignIn: false } },
    );
    expect((await app.signup()).status).toBe(200);
    expect(app.db.session).toHaveLength(0);
    expect(app.client.reportDecision).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: "allowed" }),
    );
  });

  it("ignores a customer ID supplied in signup input", async () => {
    const app = setup({ resolveCustomer: async () => "cus_owned" });
    const result = await app.request("/sign-up/email", {
      name: "Test",
      email: "user@example.com",
      password,
      stripeCustomerId: "cus_attacker",
    });
    expect(result.status).toBe(200);
    expect(app.client.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus_owned" }),
    );
    expect(app.db.user![0]).not.toHaveProperty("stripeCustomerId");
  });

  it("resolves the current mapping on every login without changing the user", async () => {
    let customerId = "cus_first";
    const resolveCustomer = vi.fn(async (user: { id?: string }) =>
      user.id ? customerId : undefined,
    );
    const app = setup({ resolveCustomer });
    await app.signup();
    const originalUser = structuredClone(app.db.user![0]);
    app.setScore(80);
    expect((await app.login()).status).toBe(403);
    expect(app.client.evaluate).toHaveBeenLastCalledWith(
      expect.objectContaining({ customerId: "cus_first" }),
    );
    customerId = "cus_updated";
    expect((await app.login()).status).toBe(403);
    expect(app.client.evaluate).toHaveBeenLastCalledWith(
      expect.objectContaining({ customerId: "cus_updated" }),
    );
    app.setScore(20);
    expect((await app.login()).status).toBe(200);
    expect(resolveCustomer).toHaveBeenCalledTimes(4);
    expect(app.db.user![0]).toEqual(originalUser);
  });

  it.each([undefined, "cus_resolved"])(
    "leaves an application-owned Customer field untouched when the resolver returns %s",
    async (customerId) => {
      const app = setup(
        { resolveCustomer: async () => customerId, failureMode: "closed" },
        {
          user: {
            additionalFields: {
              stripeCustomerId: {
                type: "string",
                required: false,
                input: false,
                returned: false,
              },
            },
          },
        },
      );
      expect((await app.signup()).status).toBe(200);
      app.db.user![0]!.stripeCustomerId = "cus_app_owned";
      const originalUser = structuredClone(app.db.user![0]);
      app.client.evaluate.mockClear();
      expect((await app.login()).status).toBe(customerId ? 200 : 503);
      if (customerId) {
        expect(app.client.evaluate).toHaveBeenCalledWith(
          expect.objectContaining({ customerId }),
        );
      } else {
        expect(app.client.evaluate).not.toHaveBeenCalled();
      }
      expect(app.db.user![0]).toEqual(originalUser);
    },
  );

  it("keeps concurrent evaluations isolated to their own requests", async () => {
    const app = setup();
    app.client.evaluate.mockImplementation(async ({ contactEmail }) => {
      await new Promise((resolve) =>
        setTimeout(resolve, contactEmail?.startsWith("first") ? 20 : 1),
      );
      return {
        id: `acctevl_${contactEmail?.startsWith("first") ? "first" : "second"}`,
        score: 20,
        riskLevel: "normal",
        signal: "user_multi_accounting",
      };
    });
    const results = await Promise.all([
      app.signup("first@example.com"),
      app.signup("second@example.com"),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(app.client.reportDecision).toHaveBeenCalledTimes(2);
    for (const email of ["first@example.com", "second@example.com"]) {
      expect(app.client.reportDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          contactEmail: email,
          evaluationId: `acctevl_${email.startsWith("first") ? "first" : "second"}`,
        }),
      );
    }
  });

  it("client plugin collects a fresh session per request and leaves unrelated calls alone", async () => {
    const app = setup({ resolveCustomer: async () => "cus_existing" });
    const createRadarSession = vi
      .fn()
      .mockResolvedValueOnce("rse_one")
      .mockResolvedValueOnce("rse_two");
    const browser = createAuthClient({
      baseURL: "http://localhost:3000",
      fetchOptions: {
        customFetchImpl: (url, init) =>
          app.auth.handler(new Request(url, init)),
      },
      plugins: [accountEvaluationsClient({ createRadarSession })],
    });
    const signup = await browser.signUp.email({
      name: "Test",
      email: "user@example.com",
      password,
    });
    expect(signup.error).toBeNull();
    expect(app.client.evaluate).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientDetails: { radar_session: "rse_one" } }),
    );
    expect(
      (await browser.signIn.email({ email: "user@example.com", password }))
        .error,
    ).toBeNull();
    expect(app.client.evaluate).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientDetails: { radar_session: "rse_two" } }),
    );
    await browser.getSession();
    expect(createRadarSession).toHaveBeenCalledTimes(2);
  });
});
