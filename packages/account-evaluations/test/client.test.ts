import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthClient } from "better-auth/client";
import { loadStripe } from "@stripe/stripe-js/pure";
import type { Stripe } from "@stripe/stripe-js";
import {
  accountEvaluationsClient,
  type AccountEvaluationsClientOptions,
} from "../src/client.js";

vi.mock("@stripe/stripe-js/pure", () => ({ loadStripe: vi.fn() }));

const signup = {
  name: "Test",
  email: "test@example.com",
  password: "test-password-123",
};
const createRadarSession = vi.fn();
const instance = { createRadarSession } as unknown as Stripe;

function setup(
  options: AccountEvaluationsClientOptions = {
    publishableKey: "pk_test_placeholder",
  },
) {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json({ ok: true }));
  const client = createAuthClient({
    baseURL: "http://localhost:3000",
    fetchOptions: { customFetchImpl: fetcher },
    plugins: [accountEvaluationsClient(options)],
  });
  return { client, fetcher };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadStripe).mockResolvedValue(instance);
  createRadarSession.mockResolvedValue({ radarSession: { id: "rse_default" } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("publishable-key client configuration", () => {
  it("does not preload during SSR and collects fresh sessions for both auth methods", async () => {
    const { client, fetcher } = setup();
    expect(loadStripe).not.toHaveBeenCalled();
    await client.getSession();
    expect(loadStripe).not.toHaveBeenCalled();
    createRadarSession
      .mockResolvedValueOnce({ radarSession: { id: "rse_signup" } })
      .mockResolvedValueOnce({ radarSession: { id: "rse_login" } });
    await client.signUp.email(signup);
    await client.signIn.email({
      email: signup.email,
      password: signup.password,
    });
    expect(loadStripe).toHaveBeenCalledExactlyOnceWith("pk_test_placeholder");
    expect(createRadarSession).toHaveBeenCalledTimes(2);
    const authCalls = fetcher.mock.calls.filter(([url]) =>
      /sign-(up|in)\/email$/.test(String(url)),
    );
    expect(
      authCalls.map(([, init]) =>
        new Headers(init?.headers).get("x-stripe-radar-session"),
      ),
    ).toEqual(["rse_signup", "rse_login"]);
  });

  it("preloads a Radar Session in the browser and consumes it on the first auth request", async () => {
    vi.stubGlobal("window", {});
    createRadarSession.mockResolvedValueOnce({
      radarSession: { id: "rse_preloaded" },
    });
    const { client, fetcher } = setup();
    await vi.waitFor(() => expect(createRadarSession).toHaveBeenCalledOnce());

    await client.signUp.email(signup);

    expect(loadStripe).toHaveBeenCalledExactlyOnceWith("pk_test_placeholder");
    expect(createRadarSession).toHaveBeenCalledOnce();
    const authCall = fetcher.mock.calls.find(([url]) =>
      String(url).endsWith("/sign-up/email"),
    );
    expect(
      new Headers(authCall?.[1]?.headers).get("x-stripe-radar-session"),
    ).toBe("rse_preloaded");

    await client.signIn.email({
      email: signup.email,
      password: signup.password,
    });
    expect(createRadarSession).toHaveBeenCalledTimes(2);
    expect(
      new Headers(fetcher.mock.calls[1]?.[1]?.headers).get(
        "x-stripe-radar-session",
      ),
    ).toBe("rse_default");
  });

  it.each(["failure", "timeout"])(
    "retries collection after a preload %s",
    async (outcome) => {
      vi.useFakeTimers();
      vi.stubGlobal("window", {});
      const collect = vi
        .fn<() => Promise<string | undefined>>()
        .mockImplementationOnce(() =>
          outcome === "failure"
            ? Promise.reject(new Error("collection failed"))
            : new Promise(() => {}),
        )
        .mockResolvedValue("rse_retry");
      const { client, fetcher } = setup({
        createRadarSession: collect,
        timeoutMs: 5,
      });
      await vi.runAllTimersAsync();
      expect(collect).toHaveBeenCalledOnce();

      expect((await client.signUp.email(signup)).error).toBeNull();
      expect(collect).toHaveBeenCalledTimes(2);
      expect(
        new Headers(fetcher.mock.calls[0]?.[1]?.headers).get(
          "x-stripe-radar-session",
        ),
      ).toBe("rse_retry");
    },
  );

  it("can disable browser preloading", async () => {
    vi.stubGlobal("window", {});
    const { client } = setup({
      publishableKey: "pk_test_placeholder",
      preload: false,
    });
    expect(loadStripe).not.toHaveBeenCalled();
    await client.signUp.email(signup);
    expect(createRadarSession).toHaveBeenCalledOnce();
  });

  it.each(["reject", "null"])(
    "falls back without a session after a %s load result and retries next time",
    async (result) => {
      const { client, fetcher } = setup();
      if (result === "reject")
        vi.mocked(loadStripe).mockRejectedValueOnce(
          new Error("script blocked"),
        );
      else vi.mocked(loadStripe).mockResolvedValueOnce(null);
      expect((await client.signUp.email(signup)).error).toBeNull();
      expect(
        new Headers(fetcher.mock.calls[0]?.[1]?.headers).get(
          "x-stripe-radar-session",
        ),
      ).toBeNull();
      expect((await client.signUp.email(signup)).error).toBeNull();
      expect(loadStripe).toHaveBeenCalledTimes(2);
      expect(
        new Headers(fetcher.mock.calls[1]?.[1]?.headers).get(
          "x-stripe-radar-session",
        ),
      ).toBe("rse_default");
    },
  );

  it("continues without a session when Stripe cannot create one", async () => {
    const { client, fetcher } = setup();
    createRadarSession.mockResolvedValueOnce({
      error: { message: "collection failed" },
    });
    expect((await client.signUp.email(signup)).error).toBeNull();
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get(
        "x-stripe-radar-session",
      ),
    ).toBeNull();
  });

  it("never loads Stripe when a custom collector is provided", async () => {
    const { client } = setup({
      createRadarSession: async () => "rse_mock",
    });
    await client.signUp.email(signup);
    expect(loadStripe).not.toHaveBeenCalled();
  });

  it.each(["", "sk_test_wrong"])(
    "rejects an invalid publishable key",
    (publishableKey) => {
      expect(() => accountEvaluationsClient({ publishableKey })).toThrow(
        "publishableKey",
      );
    },
  );
});
