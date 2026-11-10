import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { APIError, createAuthMiddleware, getIP } from "better-auth/api";
import { RADAR_SESSION_HEADER, protectedPaths } from "./shared.js";
import {
  createStripeAccountEvaluationsClient,
  validateEvaluation,
  type AccountEvaluationsClient,
  type AccountReference,
  type Activity,
  type ClientDetails,
  type DecisionReport,
  type Evaluation,
  type StripeClientOptions,
} from "./stripe.js";

export * from "./stripe.js";
export { RADAR_SESSION_HEADER } from "./shared.js";

export type EvaluationEvent = DecisionReport & {
  evaluation: Evaluation;
  reported: boolean;
};

export interface PluginErrorEvent {
  operation: "evaluation" | "report" | "callback";
  error: unknown;
  /** Failed report, available for retry. */
  report?: DecisionReport;
}

export type AccountEvaluationsOptions =
  | {
      /** Custom adapter or mock. */
      client: AccountEvaluationsClient;
      stripe?: never;
    }
  | {
      stripe: StripeClientOptions;
      client?: never;
    };

export type AccountEvaluationsConfig = AccountEvaluationsOptions & {
  /** Block scores >= this value. Default: 75. */
  blockThreshold?: number;
  /** Observe scores without blocking. Default: enforce. */
  mode?: "enforce" | "monitor";
  /** Whether auth continues when risk checks cannot complete. Default: open. */
  failureMode?: "closed" | "open";
  /** Resolve an application-owned Customer for each evaluation; signup may use email if undefined, but login requires a Customer. */
  resolveCustomer?: (user: {
    id?: string;
    email: string;
    name: string;
  }) => Promise<string | undefined>;
  onDecision?: (event: EvaluationEvent) => void | Promise<void>;
  onError?: (event: PluginErrorEvent) => void | Promise<void>;
};

type PendingEvaluation = { evaluation: Evaluation; report: DecisionReport };
class RequestState {
  pending?: PendingEvaluation;
}
type StateContext = { accountEvaluationsState?: RequestState };

export function accountEvaluations(options: AccountEvaluationsConfig) {
  const client =
    options.client ?? createStripeAccountEvaluationsClient(options.stripe);
  const failureMode = options.failureMode ?? "open";
  const threshold = options.blockThreshold ?? 75;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error("blockThreshold must be a number between 0 and 100.");
  }

  async function notifyError(
    event: PluginErrorEvent,
    ctx: GenericEndpointContext,
  ) {
    ctx.context.logger.warn(`[account-evaluations] ${event.operation} failed`);
    try {
      await options.onError?.(event);
    } catch {
      ctx.context.logger.warn("[account-evaluations] onError callback failed");
    }
  }

  async function report(
    pending: PendingEvaluation,
    ctx: GenericEndpointContext,
  ) {
    let reported = false;
    try {
      await client.reportDecision(pending.report);
      reported = true;
    } catch (error) {
      await notifyError(
        { operation: "report", error, report: pending.report },
        ctx,
      );
    }
    try {
      await options.onDecision?.({
        ...pending.report,
        evaluation: pending.evaluation,
        reported,
      });
    } catch (error) {
      await notifyError({ operation: "callback", error }, ctx);
    }
  }

  function deviceDetails(ctx: GenericEndpointContext): ClientDetails {
    // Try using the Radar Session first (this provides the most accurate signal)
    const headers = ctx.headers ?? ctx.request?.headers;
    const token = headers?.get(RADAR_SESSION_HEADER);
    if (token !== null && token !== undefined) {
      if (!/^rse_[a-zA-Z0-9_]{1,250}$/.test(token)) {
        throw new APIError("BAD_REQUEST", {
          code: "INVALID_RADAR_SESSION",
          message: "Invalid device verification. Please try again.",
        });
      }
      return { radar_session: token };
    }

    // Fall back to using IP/user-agent/referrer
    const ip = headers ? getIP(headers, ctx.context.options) : null;
    if (ip) {
      const userAgent = headers?.get("user-agent");
      const referrer = headers?.get("referer");
      return {
        data: {
          ip,
          ...(userAgent ? { user_agent: userAgent } : {}),
          ...(referrer ? { referrer } : {}),
        },
      };
    }

    // If we have nothing, we won't have enough info to evaluate, so we fail
    throw new APIError("BAD_REQUEST", {
      code: "RADAR_SESSION_REQUIRED",
      message: "Device verification is required. Please try again.",
    });
  }

  async function evaluate(
    user: {
      id?: string;
      email: string;
      name: string;
    },
    activity: Activity,
    ctx: GenericEndpointContext,
  ): Promise<void> {
    // Attempt to get client details.
    let clientDetails: ClientDetails;
    try {
      clientDetails = deviceDetails(ctx);
    } catch (error) {
      await notifyError({ operation: "evaluation", error }, ctx);
      if (failureMode === "open") return;
      throw error;
    }

    // Attempt to get an evaluation.
    let account: AccountReference;
    let evaluation: Evaluation;
    try {
      // Customer ID validation
      const customerId = await options.resolveCustomer?.(user);
      if (activity === "login" && !customerId)
        throw new Error("Login evaluation requires a Stripe Customer.");
      if (customerId && !/^cus_[a-zA-Z0-9]+$/.test(customerId))
        throw new Error("Invalid Stripe customer ID.");

      account = customerId ? { customerId } : { contactEmail: user.email };
      evaluation = validateEvaluation(
        await client.evaluate({ ...account, activity, clientDetails }),
        activity === "registration"
          ? "user_multi_accounting"
          : "user_account_sharing",
      );
    } catch (error) {
      await notifyError({ operation: "evaluation", error }, ctx);
      if (failureMode === "open") return;
      throw new APIError("SERVICE_UNAVAILABLE", {
        code: "ACCOUNT_EVALUATION_UNAVAILABLE",
        message: "Unable to verify this attempt. Please try again shortly.",
      });
    }

    // If the eval shows high-risk (and we're not in monitor mode), block
    const blocked = options.mode !== "monitor" && evaluation.score >= threshold;
    const pending: PendingEvaluation = {
      evaluation,
      report: {
        ...account,
        evaluationId: evaluation.id,
        activity,
        status: blocked ? "blocked" : "allowed",
      },
    };

    // 403 if blocked
    if (blocked) {
      await report(pending, ctx);
      throw new APIError("FORBIDDEN", {
        code: "ACCOUNT_EVALUATION_BLOCKED",
        message:
          "We couldn't complete this request. Please contact support if you need help.",
      });
    }

    // Save result in state. Note that this is required for reporting.
    const state = (ctx.context as StateContext).accountEvaluationsState;
    if (!state)
      throw new Error("Account evaluations request context is missing.");
    state.pending = pending;
  }

  return {
    id: "account-evaluations",
    version: "0.1.0",
    init() {
      return {
        options: {
          databaseHooks: {
            user: {
              create: {
                async before(user, ctx) {
                  if (ctx?.path !== "/sign-up/email") return;
                  await evaluate(user, "registration", ctx);
                },
              },
            },
            session: {
              create: {
                async before(session, ctx) {
                  if (ctx?.path !== "/sign-in/email") return;
                  const user = await ctx.context.internalAdapter.findUserById(
                    session.userId,
                  );
                  if (!user)
                    throw new APIError("UNAUTHORIZED", {
                      message: "Invalid credentials.",
                    });
                  await evaluate(user, "login", ctx);
                },
              },
            },
          },
        },
      };
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => protectedPaths.some((path) => path === ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            (ctx.context as StateContext).accountEvaluationsState =
              new RequestState();
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => protectedPaths.some((path) => path === ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const state = (ctx.context as StateContext).accountEvaluationsState;
            const pending = state?.pending;
            if (!pending) return;
            state.pending = undefined;
            const result = ctx.context.returned;
            // Report allowed only after auth succeeds.
            if (
              result &&
              typeof result === "object" &&
              "user" in result &&
              !(result instanceof APIError)
            ) {
              await report(pending, ctx);
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
