import { randomUUID } from "node:crypto";
import Stripe from "stripe";

export const STRIPE_API_VERSION: Stripe.LatestApiVersion = "2026-10-14.preview";

export type Activity = "registration" | "login";
export type Signal = "user_multi_accounting" | "user_account_sharing";
type SdkEvaluatedSignals = NonNullable<
  Stripe.V2.Signals.AccountEvaluation["evaluated_signals"]
>;
type SdkSharingSignal = NonNullable<
  SdkEvaluatedSignals["user_account_sharing"]
>;
type SdkClientDetails =
  Stripe.V2.Signals.AccountEvaluationCreateParams.AccountActivityDetails.Data.RegistrationAttempt.ClientDetails;
export type RiskLevel = SdkSharingSignal["risk_level"];
export type Decision = "allowed" | "blocked";
export type ClientDetails =
  | { radar_session: NonNullable<SdkClientDetails["radar_session"]> }
  | { data: NonNullable<SdkClientDetails["data"]> };

export interface Evaluation {
  id: string;
  signal: Signal;
  score: number;
  riskLevel: RiskLevel;
}

export type AccountReference =
  | { customerId: string; contactEmail?: never }
  | { customerId?: never; contactEmail: string };

export type DecisionReport = AccountReference & {
  evaluationId: string;
  activity: Activity;
  status: Decision;
};

export interface AccountEvaluationsClient {
  evaluate(
    input: AccountReference & {
      activity: Activity;
      clientDetails: ClientDetails;
    },
  ): Promise<Evaluation>;
  reportDecision(report: DecisionReport): Promise<void>;
}

export interface StripeClientOptions {
  secretKey: string;
  /** Per-request timeout. Defaults to 5 seconds. */
  timeoutMs?: number;
  /** Existing SDK instance. */
  stripeClient?: Stripe;
}

export function validateEvaluation(
  value: Evaluation,
  signal: Signal,
): Evaluation {
  if (
    !value.id?.startsWith("acctevl_") ||
    value.signal !== signal ||
    !Number.isFinite(value.score) ||
    value.score < 0 ||
    value.score > 100 ||
    !["low", "normal", "elevated", "highest", "unknown"].includes(
      value.riskLevel,
    )
  ) {
    throw new Error("Stripe did not return a usable risk signal.");
  }
  return value;
}

function scoreNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  if (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value &&
    typeof value.toNumber === "function"
  ) {
    return value.toNumber();
  }
  return NaN;
}

export function createStripeAccountEvaluationsClient(
  options: StripeClientOptions,
): AccountEvaluationsClient {
  if (!options.secretKey.trim())
    throw new Error("A Stripe secret key is required.");
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive integer.");
  }
  const stripe =
    options.stripeClient ??
    new Stripe(options.secretKey, {
      timeout: timeoutMs,
      maxNetworkRetries: 0,
      typescript: true,
      appInfo: {
        name: "@stripe/radar-better-auth",
        version: "0.1.0",
      },
    });

  function accountDetails(
    reference: AccountReference,
  ): Stripe.V2.Signals.AccountEvaluationCreateParams.AccountDetails {
    if (reference.customerId) return { customer: reference.customerId };
    return {
      data: { contact_email: reference.contactEmail },
    };
  }

  return {
    async evaluate({ activity, clientDetails, ...reference }) {
      const signal: Signal =
        activity === "registration"
          ? "user_multi_accounting"
          : "user_account_sharing";
      const type = `${activity}_attempt` as const;
      const activityData =
        activity === "registration"
          ? {
              type,
              registration_attempt: { client_details: clientDetails },
            }
          : {
              type,
              login_attempt: { client_details: clientDetails },
            };
      const result = await stripe.v2.signals.accountEvaluations.create(
        {
          account_details: accountDetails(reference),
          requested_signals: [signal],
          account_activity_details: { data: activityData },
        },
        {
          apiVersion: STRIPE_API_VERSION,
          idempotencyKey: `ba-evaluation-${randomUUID()}`,
        },
      );
      const evaluated =
        signal === "user_multi_accounting"
          ? result.evaluated_signals?.user_multi_accounting
          : result.evaluated_signals?.user_account_sharing;
      if (!evaluated)
        throw new Error("Stripe did not return the requested signal.");
      return validateEvaluation(
        {
          id: result.id,
          signal,
          score: scoreNumber(evaluated.score),
          riskLevel: evaluated.risk_level,
        },
        signal,
      );
    },

    async reportDecision({ evaluationId, activity, status, ...reference }) {
      const type = `${activity}_decision` as const;
      const decision = { status };
      await stripe.v2.signals.accountActivities.create(
        {
          account_details: accountDetails(reference),
          account_evaluation: evaluationId,
          type,
          ...(activity === "registration"
            ? { registration_decision: decision }
            : { login_decision: decision }),
        },
        {
          apiVersion: STRIPE_API_VERSION,
          idempotencyKey: `ba-decision-${evaluationId}-${status}`,
        },
      );
    },
  };
}
