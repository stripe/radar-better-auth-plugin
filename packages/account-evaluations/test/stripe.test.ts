import { describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import {
  createStripeAccountEvaluationsClient,
  type Signal,
} from "../src/stripe.js";

function fixture(
  score: unknown = "80.0",
  signal: Signal = "user_multi_accounting",
) {
  return {
    id: "acctevl_test",
    evaluated_signals: {
      [signal]: { score, risk_level: "highest" },
    },
  };
}

function setup(evaluation: unknown = fixture()) {
  const evaluationsCreate = vi.fn().mockResolvedValue(evaluation);
  const activitiesCreate = vi.fn().mockResolvedValue({ id: "acctact_test" });
  const stripeClient = {
    v2: {
      signals: {
        accountEvaluations: { create: evaluationsCreate },
        accountActivities: { create: activitiesCreate },
      },
    },
  } as unknown as Stripe;
  return {
    client: createStripeAccountEvaluationsClient({
      secretKey: "sk_test_placeholder",
      stripeClient,
    }),
    evaluationsCreate,
    activitiesCreate,
  };
}

describe("official Stripe SDK adapter", () => {
  it("uses the generated v2 Signals resources", async () => {
    const { client, evaluationsCreate, activitiesCreate } = setup();
    const evaluation = await client.evaluate({
      customerId: "cus_test",
      activity: "registration",
      clientDetails: { radar_session: "rse_test" },
    });
    expect(evaluation).toEqual({
      id: "acctevl_test",
      signal: "user_multi_accounting",
      score: 80,
      riskLevel: "highest",
    });
    await client.reportDecision({
      customerId: "cus_test",
      evaluationId: evaluation.id,
      activity: "registration",
      status: "blocked",
    });

    expect(evaluationsCreate).toHaveBeenCalledWith(
      {
        account_details: { customer: "cus_test" },
        requested_signals: ["user_multi_accounting"],
        account_activity_details: {
          data: {
            type: "registration_attempt",
            registration_attempt: {
              client_details: { radar_session: "rse_test" },
            },
          },
        },
      },
      {
        apiVersion: "2026-10-14.preview",
        idempotencyKey: expect.stringMatching(/^ba-evaluation-/),
      },
    );
    expect(activitiesCreate).toHaveBeenCalledWith(
      {
        account_details: { customer: "cus_test" },
        account_evaluation: "acctevl_test",
        type: "registration_decision",
        registration_decision: { status: "blocked" },
      },
      {
        apiVersion: "2026-10-14.preview",
        idempotencyKey: "ba-decision-acctevl_test-blocked",
      },
    );
  });

  it("maps the trusted IP fallback to the generated SDK schema", async () => {
    const { client, evaluationsCreate } = setup({
      id: "acctevl_test",
      evaluated_signals: {
        user_account_sharing: { score: "20", risk_level: "normal" },
      },
    });
    await client.evaluate({
      customerId: "cus_test",
      activity: "login",
      clientDetails: {
        data: {
          ip: "203.0.113.1",
          user_agent: "test-agent",
          referrer: "https://example.com",
        },
      },
    });
    expect(evaluationsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        requested_signals: ["user_account_sharing"],
        account_activity_details: {
          data: {
            type: "login_attempt",
            login_attempt: {
              client_details: {
                data: {
                  ip: "203.0.113.1",
                  user_agent: "test-agent",
                  referrer: "https://example.com",
                },
              },
            },
          },
        },
      }),
      expect.objectContaining({ apiVersion: "2026-10-14.preview" }),
    );
  });

  it("uses inline contact email for entityless evaluations and decisions", async () => {
    const { client, evaluationsCreate, activitiesCreate } = setup();
    const evaluation = await client.evaluate({
      contactEmail: "user@example.com",
      activity: "registration",
      clientDetails: { radar_session: "rse_test" },
    });
    await client.reportDecision({
      contactEmail: "user@example.com",
      evaluationId: evaluation.id,
      activity: "registration",
      status: "allowed",
    });

    expect(evaluationsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        account_details: {
          data: { contact_email: "user@example.com" },
        },
      }),
      expect.objectContaining({ apiVersion: "2026-10-14.preview" }),
    );
    expect(activitiesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        account_details: {
          data: { contact_email: "user@example.com" },
        },
      }),
      expect.objectContaining({ apiVersion: "2026-10-14.preview" }),
    );
  });

  it.each(["registration", "login"] as const)(
    "pins the preview version through the real SDK for %s evaluations and decisions",
    async (activity) => {
      const signal =
        activity === "registration"
          ? "user_multi_accounting"
          : "user_account_sharing";
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(fixture("80.0", signal)))
        .mockResolvedValueOnce(Response.json({ id: "acctact_test" }));
      const client = createStripeAccountEvaluationsClient({
        secretKey: "sk_test_placeholder",
        stripeClient: new Stripe("sk_test_placeholder", {
          // An existing integration may use an older API version.
          apiVersion: "2026-09-30.preview" as Stripe.LatestApiVersion,
          httpClient: Stripe.createFetchHttpClient(fetcher),
        }),
      });
      const evaluation = await client.evaluate({
        contactEmail: "user@example.com",
        activity,
        clientDetails: { radar_session: "rse_test" },
      });
      await client.reportDecision({
        contactEmail: "user@example.com",
        evaluationId: evaluation.id,
        activity,
        status: "allowed",
      });
      expect(
        fetcher.mock.calls.map(([, init]) =>
          new Headers(init?.headers).get("Stripe-Version"),
        ),
      ).toEqual(["2026-10-14.preview", "2026-10-14.preview"]);
    },
  );

  it.each([null, "", "NaN", 101, -1, true])(
    "rejects invalid score %s instead of allowing by accident",
    async (score) => {
      const { client } = setup(fixture(score));
      await expect(
        client.evaluate({
          customerId: "cus_test",
          activity: "registration",
          clientDetails: { radar_session: "rse_test" },
        }),
      ).rejects.toThrow();
    },
  );

  it("rejects a missing requested signal", async () => {
    const { client } = setup({
      id: "acctevl_test",
      evaluated_signals: {},
    });
    await expect(
      client.evaluate({
        customerId: "cus_test",
        activity: "registration",
        clientDetails: { radar_session: "rse_test" },
      }),
    ).rejects.toThrow("did not return the requested signal");
  });

  it("propagates official Stripe SDK errors", async () => {
    const { client, evaluationsCreate } = setup();
    const error = new Stripe.errors.StripeAPIError({
      message: "request failed",
      requestId: "req_test",
      statusCode: 429,
      type: "api_error",
    });
    evaluationsCreate.mockRejectedValueOnce(error);
    await expect(
      client.evaluate({
        customerId: "cus_test",
        activity: "registration",
        clientDetails: { radar_session: "rse_test" },
      }),
    ).rejects.toBe(error);
  });

  it("validates configuration before constructing the SDK", () => {
    expect(() =>
      createStripeAccountEvaluationsClient({ secretKey: "" }),
    ).toThrow("secret key");
    expect(() =>
      createStripeAccountEvaluationsClient({
        secretKey: "sk_test_placeholder",
        timeoutMs: 0,
      }),
    ).toThrow("timeoutMs");
  });
});
