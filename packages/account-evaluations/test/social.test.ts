import { afterEach, describe, expect, it, vi } from "vitest";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  APIError,
  addOAuthServerContext,
  getIP,
  getOAuthState,
} from "better-auth/api";
import {
  accountEvaluations,
  type AccountEvaluationsClient,
  type AccountEvaluationsConfig,
} from "../src/index.js";

vi.mock("better-auth/api", async (importOriginal) => {
  const api = await importOriginal<typeof import("better-auth/api")>();
  return {
    ...api,
    addOAuthServerContext: vi.fn(api.addOAuthServerContext),
    getOAuthState: vi.fn(api.getOAuthState),
    getIP: vi.fn(api.getIP),
  };
});

afterEach(() => {
  vi.mocked(addOAuthServerContext).mockReset();
  vi.mocked(getOAuthState).mockReset();
  vi.mocked(getIP).mockReset();
});

const baseURL = "http://localhost:3000";
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");

async function setup(
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
        id: "acctevl_social",
        signal:
          activity === "registration"
            ? "user_multi_accounting"
            : "user_account_sharing",
        score,
        riskLevel: score >= 75 ? "highest" : "normal",
      })),
    reportDecision: vi
      .fn<AccountEvaluationsClient["reportDecision"]>()
      .mockResolvedValue(undefined),
  };
  const auth = betterAuth({
    baseURL,
    secret: "test-only-secret-with-at-least-32-characters",
    database: memoryAdapter(db),
    logger: { disabled: true },
    socialProviders: {
      google: {
        clientId: "test-client",
        clientSecret: "test-secret",
        verifyIdToken: async (token) => token === "valid-token",
        getUserInfo: async () => ({
          user: {
            email: "social@example.com",
            name: "Social User",
            emailVerified: true,
          },
          data: {
            sub: "social-user",
            email: "social@example.com",
            email_verified: true,
            name: "Social User",
            given_name: "Social",
            family_name: "User",
            picture: "https://example.com/avatar.png",
            aud: "test-client",
            azp: "test-client",
            iss: "https://accounts.google.com",
            iat: 0,
            exp: 1,
            locale: "en",
          },
        }),
      },
    },
    ...authOptions,
    plugins: [
      accountEvaluations({ client, ...config } as AccountEvaluationsConfig),
    ],
  });
  // Stub only the provider's network boundary. Requests still traverse Better
  // Auth's real state validation, account lookup, database hooks and cookies.
  const provider = (await auth.$context).socialProviders.find(
    (entry) => entry.id === "google",
  )!;
  provider.validateAuthorizationCode = vi
    .fn()
    .mockResolvedValue({ accessToken: "test-access-token" });

  const request = (path: string, body: object, headers: HeadersInit = {}) =>
    auth.handler(
      new Request(`${baseURL}/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: baseURL,
          ...Object.fromEntries(new Headers(headers)),
        },
        body: JSON.stringify(body),
      }),
    );
  async function start(
    headers: HeadersInit = { "x-stripe-radar-session": "rse_start" },
    extra: object = {},
  ) {
    const response = await request(
      "/sign-in/social",
      {
        provider: "google",
        callbackURL: `${baseURL}/welcome`,
        errorCallbackURL: `${baseURL}/denied`,
        disableRedirect: true,
        ...extra,
      },
      headers,
    );
    expect(response.status).toBe(200);
    const url = new URL((await response.json()).url);
    return { state: url.searchParams.get("state")!, cookie: cookies(response) };
  }
  const complete = (
    flow: { state: string; cookie: string },
    params: Record<string, string> = { code: "valid-code" },
  ) =>
    auth.handler(
      new Request(
        `${baseURL}/api/auth/callback/google?${new URLSearchParams({ state: flow.state, ...params })}`,
        {
          headers: {
            cookie: flow.cookie,
            "x-stripe-radar-session": "rse_callback",
            "x-forwarded-for": "192.0.2.99",
          },
        },
      ),
    );
  const idToken = (token = "valid-token") =>
    request(
      "/sign-in/social",
      {
        provider: "google",
        idToken: { token },
      },
      { "x-stripe-radar-session": "rse_direct" },
    );
  return {
    auth,
    db,
    client,
    request,
    start,
    complete,
    idToken,
    provider,
    setScore: (value: number) => {
      score = value;
    },
  };
}

describe.each(["database", "cookie"] as const)(
  "social redirects with %s state",
  (storeStateStrategy) => {
    it("carries Radar evidence through OAuth and evaluates signup and subsequent login once each", async () => {
      const resolveCustomer = vi.fn().mockResolvedValue("cus_social");
      const app = await setup(
        { resolveCustomer },
        { account: { storeStateStrategy } },
      );
      const flow = await app.start();
      expect(app.client.evaluate).not.toHaveBeenCalled();
      expect(app.client.reportDecision).not.toHaveBeenCalled();
      const response = await app.complete(flow);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`${baseURL}/welcome`);
      expect(response.headers.get("set-cookie")).toContain("session_token");
      expect(app.db.user).toHaveLength(1);
      expect(app.db.session).toHaveLength(1);
      expect(app.client.evaluate).toHaveBeenCalledExactlyOnceWith({
        customerId: "cus_social",
        activity: "registration",
        clientDetails: { radar_session: "rse_start" },
      });
      expect(app.client.reportDecision).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          activity: "registration",
          status: "allowed",
        }),
      );
      const login = await app.complete(await app.start());
      expect(login.headers.get("location")).toBe(`${baseURL}/welcome`);
      expect(app.db.session).toHaveLength(2);
      expect(app.client.evaluate).toHaveBeenCalledTimes(2);
      expect(app.client.evaluate).toHaveBeenLastCalledWith({
        customerId: "cus_social",
        activity: "login",
        clientDetails: { radar_session: "rse_start" },
      });
      expect(resolveCustomer).toHaveBeenLastCalledWith(
        expect.objectContaining({
          id: app.db.user![0]!.id,
          email: "social@example.com",
        }),
      );
      expect(app.client.reportDecision).toHaveBeenCalledTimes(2);
      expect(app.client.reportDecision).toHaveBeenLastCalledWith(
        expect.objectContaining({ activity: "login", status: "allowed" }),
      );
    });

    it.each(["registration", "login"])(
      "blocks high-risk %s before creating a user or session",
      async (activity) => {
        const app = await setup(
          { resolveCustomer: async () => "cus_social" },
          { account: { storeStateStrategy } },
        );
        if (activity === "login") await app.complete(await app.start());
        const users = app.db.user!.length;
        const sessions = app.db.session!.length;
        app.client.reportDecision.mockClear();
        app.setScore(80);
        const response = await app.complete(await app.start());
        expect(response.status).toBe(302);
        expect(
          new URL(response.headers.get("location")!).searchParams.get("error"),
        ).toBe("ACCOUNT_EVALUATION_BLOCKED");
        expect(response.headers.get("set-cookie") ?? "").not.toContain(
          "session_token",
        );
        expect(app.db.user).toHaveLength(users);
        expect(app.db.session).toHaveLength(sessions);
        if (activity === "registration") expect(app.db.account).toHaveLength(0);
        expect(app.client.reportDecision).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ activity, status: "blocked" }),
        );
      },
    );

    it("rejects mismatched state before evaluating or creating a user", async () => {
      const app = await setup({}, { account: { storeStateStrategy } });
      const first = await app.start();
      const second = await app.start();
      const response = await app.complete({
        state: first.state,
        cookie: second.cookie,
      });
      expect(response.status).toBe(302);
      expect(
        new URL(response.headers.get("location")!).searchParams.get("error"),
      ).toBe("state_mismatch");
      expect(app.client.evaluate).not.toHaveBeenCalled();
      expect(app.db.user).toHaveLength(0);
    });

    it("keeps device evidence separate for concurrent flows and ignores client-supplied state context", async () => {
      const app = await setup(
        { resolveCustomer: async () => "cus_social" },
        { account: { storeStateStrategy } },
      );
      const extra = {
        additionalData: {
          accountEvaluationsDevice: { radar_session: "rse_forged" },
          serverContext: {
            accountEvaluationsDevice: { radar_session: "rse_forged" },
          },
        },
      };
      const first = await app.start(
        { "x-stripe-radar-session": "rse_first" },
        extra,
      );
      const second = await app.start(
        { "x-stripe-radar-session": "rse_second" },
        extra,
      );
      await app.complete(second);
      await app.complete(first);
      expect(
        app.client.evaluate.mock.calls.map(([input]) => input.clientDetails),
      ).toEqual([
        { radar_session: "rse_second" },
        { radar_session: "rse_first" },
      ]);
    });
  },
);

describe("social authentication policies", () => {
  describe.each([undefined, "open", "closed"] as const)(
    "hook failures with failureMode: %s",
    (failureMode) => {
      it.each(["device collection", "OAuth context storage"])(
        "handles an unexpected failure in %s",
        async (operation) => {
          const error = new Error(`${operation} failed`);
          const onError = vi.fn();
          const app = await setup({ failureMode, onError });
          if (operation === "device collection") {
            vi.mocked(getIP).mockImplementationOnce(() => {
              throw error;
            });
          } else {
            vi.mocked(addOAuthServerContext).mockRejectedValueOnce(error);
          }
          const response = await app.request("/sign-in/social", {
            provider: "google",
            callbackURL: `${baseURL}/welcome`,
            disableRedirect: true,
          });
          expect(response.status).toBe(failureMode === "closed" ? 503 : 200);
          expect(onError).toHaveBeenCalledExactlyOnceWith({
            operation: "evaluation",
            error,
          });
          expect(app.client.evaluate).not.toHaveBeenCalled();
          if (failureMode === "closed") {
            expect(await response.json()).toMatchObject({
              code: "ACCOUNT_EVALUATION_UNAVAILABLE",
            });
            return;
          }
          const state = new URL((await response.json()).url).searchParams.get(
            "state",
          )!;
          const result = await app.complete({
            state,
            cookie: cookies(response),
          });
          expect(result.headers.get("location")).toBe(`${baseURL}/welcome`);
          expect(app.db.session).toHaveLength(1);
        },
      );

      it("handles OAuth context retrieval failure without allowing an unverified identity", async () => {
        const onError = vi.fn();
        const app = await setup({ failureMode, onError });
        const flow = await app.start();
        const error = new Error("OAuth context unavailable");
        vi.mocked(getOAuthState).mockRejectedValueOnce(error);
        const response = await app.complete(flow);
        expect(app.db.session).toHaveLength(failureMode === "closed" ? 0 : 1);
        expect(app.client.evaluate).not.toHaveBeenCalled();
        expect(app.client.reportDecision).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledExactlyOnceWith({
          operation: "evaluation",
          error,
        });
        if (failureMode === "closed") {
          expect(
            new URL(response.headers.get("location")!).searchParams.get(
              "error",
            ),
          ).toBe("ACCOUNT_EVALUATION_UNAVAILABLE");
        } else {
          expect(response.headers.get("location")).toBe(`${baseURL}/welcome`);
        }
      });
    },
  );

  it("preserves the initiating request's IP fallback", async () => {
    const app = await setup();
    await app.complete(
      await app.start({
        "x-forwarded-for": "203.0.113.10",
        "user-agent": "test-browser",
        referer: `${baseURL}/login`,
      }),
    );
    expect(app.client.evaluate).toHaveBeenCalledExactlyOnceWith({
      contactEmail: "social@example.com",
      activity: "registration",
      clientDetails: {
        data: {
          ip: "203.0.113.10",
          user_agent: "test-browser",
          referrer: `${baseURL}/login`,
        },
      },
    });
  });

  it.each(["open", "closed"] as const)(
    "preserves %s behavior for missing device evidence",
    async (failureMode) => {
      const onError = vi.fn();
      const app = await setup(
        { failureMode, onError },
        { advanced: { ipAddress: { disableIpTracking: true } } },
      );
      const response = await app.complete(await app.start({}));
      expect(app.db.user).toHaveLength(failureMode === "open" ? 1 : 0);
      expect(app.db.session).toHaveLength(failureMode === "open" ? 1 : 0);
      expect(app.client.evaluate).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
      if (failureMode === "closed")
        expect(
          new URL(response.headers.get("location")!).searchParams.get("error"),
        ).toBe("RADAR_SESSION_REQUIRED");
    },
  );

  it.each(["open", "closed"] as const)(
    "preserves %s behavior on evaluation failure without a second login evaluation",
    async (failureMode) => {
      const app = await setup({ failureMode });
      app.client.evaluate.mockRejectedValue(new Error("offline"));
      const response = await app.complete(await app.start());
      expect(app.db.session).toHaveLength(failureMode === "open" ? 1 : 0);
      expect(app.client.evaluate).toHaveBeenCalledTimes(1);
      expect(app.client.reportDecision).not.toHaveBeenCalled();
      if (failureMode === "closed")
        expect(
          new URL(response.headers.get("location")!).searchParams.get("error"),
        ).toBe("ACCOUNT_EVALUATION_UNAVAILABLE");
    },
  );

  it("reports high-risk registrations as allowed in monitor mode", async () => {
    const app = await setup({ mode: "monitor" });
    app.setScore(80);
    expect(
      (await app.complete(await app.start())).headers.get("location"),
    ).toBe(`${baseURL}/welcome`);
    expect(app.client.reportDecision).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: "allowed", activity: "registration" }),
    );
  });

  it("does not report allowed when session creation is rejected by another hook", async () => {
    const app = await setup(
      {},
      {
        databaseHooks: {
          session: {
            create: {
              before: async () => {
                throw new APIError("FORBIDDEN", {
                  code: "APP_BLOCKED",
                  message: "Blocked",
                });
              },
            },
          },
        },
      },
    );
    const response = await app.complete(await app.start());
    expect(
      new URL(response.headers.get("location")!).searchParams.get("error"),
    ).toBe("APP_BLOCKED");
    expect(app.client.evaluate).toHaveBeenCalledOnce();
    expect(app.client.reportDecision).not.toHaveBeenCalled();
    expect(app.db.session).toHaveLength(0);
  });

  it("does not evaluate a provider-denied callback", async () => {
    const app = await setup();
    await app.complete(await app.start(), { error: "access_denied" });
    expect(app.client.evaluate).not.toHaveBeenCalled();
    expect(app.db.user).toHaveLength(0);
  });

  it("handles a provider's POST callback through Better Auth's GET redirect", async () => {
    const app = await setup();
    const flow = await app.start();
    const post = await app.auth.handler(
      new Request(`${baseURL}/api/auth/callback/google`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: flow.cookie,
        },
        body: new URLSearchParams({ code: "valid-code", state: flow.state }),
      }),
    );
    expect(post.status).toBe(302);
    expect(app.client.evaluate).not.toHaveBeenCalled();
    const response = await app.auth.handler(
      new Request(post.headers.get("location")!, {
        headers: { cookie: flow.cookie },
      }),
    );
    expect(response.headers.get("location")).toBe(`${baseURL}/welcome`);
    expect(app.client.evaluate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        clientDetails: { radar_session: "rse_start" },
      }),
    );
    expect(app.client.reportDecision).toHaveBeenCalledOnce();
  });

  it("requires a Customer mapping for returning social users when failing closed", async () => {
    const app = await setup({ failureMode: "closed" });
    await app.complete(await app.start());
    app.client.evaluate.mockClear();
    app.client.reportDecision.mockClear();
    const response = await app.complete(await app.start());
    expect(
      new URL(response.headers.get("location")!).searchParams.get("error"),
    ).toBe("ACCOUNT_EVALUATION_UNAVAILABLE");
    expect(app.client.evaluate).not.toHaveBeenCalled();
    expect(app.client.reportDecision).not.toHaveBeenCalled();
    expect(app.db.session).toHaveLength(1);
  });

  it("preserves invalid Radar evidence until the verified callback", async () => {
    const onError = vi.fn();
    const app = await setup({ failureMode: "closed", onError });
    const flow = await app.start({ "x-stripe-radar-session": "invalid" });
    expect(onError).not.toHaveBeenCalled();
    const response = await app.complete(flow);
    expect(
      new URL(response.headers.get("location")!).searchParams.get("error"),
    ).toBe("INVALID_RADAR_SESSION");
    expect(app.client.evaluate).not.toHaveBeenCalled();
    expect(app.db.user).toHaveLength(0);
  });

  it.each([20, 80])(
    "reporting failures cannot change the OAuth decision at score %s",
    async (score) => {
      const onError = vi.fn();
      const app = await setup({ onError });
      app.setScore(score);
      app.client.reportDecision.mockRejectedValue(
        new Error("report unavailable"),
      );
      const response = await app.complete(await app.start());
      expect(app.db.session).toHaveLength(score < 75 ? 1 : 0);
      expect(response.headers.get("location")).toContain(
        score < 75 ? "/welcome" : "error=ACCOUNT_EVALUATION_BLOCKED",
      );
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "report" }),
      );
    },
  );

  it("leaves explicit account linking outside registration and login evaluation", async () => {
    const app = await setup();
    const session = await app.idToken();
    app.client.evaluate.mockClear();
    app.client.reportDecision.mockClear();
    const response = await app.request(
      "/link-social",
      {
        provider: "google",
        callbackURL: `${baseURL}/settings`,
        disableRedirect: true,
      },
      { cookie: cookies(session) },
    );
    expect(response.status).toBe(200);
    const state = new URL((await response.json()).url).searchParams.get(
      "state",
    )!;
    const callback = await app.complete({ state, cookie: cookies(response) });
    expect(callback.headers.get("location")).toBe(`${baseURL}/settings`);
    expect(app.client.evaluate).not.toHaveBeenCalled();
    expect(app.client.reportDecision).not.toHaveBeenCalled();
    expect(app.db.session).toHaveLength(1);
  });

  it("blocks high-risk ID-token signup before creating a user", async () => {
    const app = await setup();
    app.setScore(80);
    const response = await app.idToken();
    expect(response.status).toBe(403);
    expect(app.db.user).toHaveLength(0);
    expect(app.db.account).toHaveLength(0);
    expect(app.db.session).toHaveLength(0);
    expect(app.client.reportDecision).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ activity: "registration", status: "blocked" }),
    );
  });

  it("evaluates direct ID-token signup and login after token verification", async () => {
    const app = await setup({ resolveCustomer: async () => "cus_social" });
    expect((await app.idToken("invalid-token")).status).toBe(401);
    expect(app.client.evaluate).not.toHaveBeenCalled();
    expect((await app.idToken()).status).toBe(200);
    expect(app.client.evaluate).toHaveBeenCalledExactlyOnceWith({
      customerId: "cus_social",
      activity: "registration",
      clientDetails: { radar_session: "rse_direct" },
    });
    app.setScore(80);
    expect((await app.idToken()).status).toBe(403);
    expect(app.db.session).toHaveLength(1);
    expect(app.client.evaluate).toHaveBeenCalledTimes(2);
    expect(app.client.reportDecision).toHaveBeenLastCalledWith(
      expect.objectContaining({ activity: "login", status: "blocked" }),
    );
    app.setScore(20);
    expect((await app.idToken()).status).toBe(200);
    expect(app.db.session).toHaveLength(2);
    expect(app.client.reportDecision).toHaveBeenLastCalledWith(
      expect.objectContaining({ activity: "login", status: "allowed" }),
    );
  });
});
