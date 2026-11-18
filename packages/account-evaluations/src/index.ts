import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import {
  APIError,
  addOAuthServerContext,
  createAuthMiddleware,
  getIP,
  getOAuthState,
  isAPIError,
} from "better-auth/api";
import {
  RADAR_SESSION_HEADER,
  isProtectedPath,
  isSocialCallback,
} from "./shared.js";
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
  registration = false;
}
type StateContext = { accountEvaluationsState?: RequestState };

function requestState(ctx: GenericEndpointContext): RequestState {
  const state = (ctx.context as StateContext).accountEvaluationsState;
  if (!state)
    throw new Error("Account evaluations request context is missing.");
  return state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function deviceError(code: "INVALID_RADAR_SESSION" | "RADAR_SESSION_REQUIRED") {
  return new APIError("BAD_REQUEST", {
    code,
    message:
      code === "INVALID_RADAR_SESSION"
        ? "Invalid device verification. Please try again."
        : "Device verification is required. Please try again.",
  });
}

export function accountEvaluations(options: AccountEvaluationsConfig) {
  const client =
    options.client ?? createStripeAccountEvaluationsClient(options.stripe);
  const failureMode = options.failureMode ?? "open";
  const threshold = options.blockThreshold ?? 75;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error("blockThreshold must be a number between 0 and 100.");
  }

  function warn(ctx: GenericEndpointContext, message: string) {
    try {
      ctx.context.logger.warn(message);
    } catch {
      // Logging failures must not change the authentication result.
    }
  }

  async function notifyError(
    event: PluginErrorEvent,
    ctx: GenericEndpointContext,
  ) {
    warn(ctx, `[account-evaluations] ${event.operation} failed`);
    try {
      await options.onError?.(event);
    } catch {
      warn(ctx, "[account-evaluations] onError callback failed");
    }
  }

  async function handleEvaluationError(
    error: unknown,
    ctx: GenericEndpointContext,
    responseError?: APIError,
  ) {
    await notifyError({ operation: "evaluation", error }, ctx);
    if (failureMode === "open") return;
    throw (
      responseError ??
      new APIError("SERVICE_UNAVAILABLE", {
        code: "ACCOUNT_EVALUATION_UNAVAILABLE",
        message: "Unable to verify this attempt. Please try again shortly.",
      })
    );
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

  function deviceDetailsFromRequest(
    ctx: GenericEndpointContext,
  ): ClientDetails {
    // Try using the Radar Session first (this provides the most accurate signal)
    const headers = ctx.headers ?? ctx.request?.headers;
    const token = headers?.get(RADAR_SESSION_HEADER);
    if (token !== null && token !== undefined) {
      if (!/^rse_[a-zA-Z0-9_]{1,250}$/.test(token)) {
        throw deviceError("INVALID_RADAR_SESSION");
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
    throw deviceError("RADAR_SESSION_REQUIRED");
  }

  async function evaluationDeviceDetails(
    ctx: GenericEndpointContext,
  ): Promise<ClientDetails> {
    if (!isSocialCallback(ctx.path)) return deviceDetailsFromRequest(ctx);

    // Our goal is to recover the device details from the initial before hook.
    const saved = (await getOAuthState())?.serverContext
      ?.accountEvaluationsDevice;

    // No device details, fall back to current-request details
    if (!isRecord(saved)) return deviceDetailsFromRequest(ctx);

    // Explicit failure
    if (
      saved.error === "INVALID_RADAR_SESSION" ||
      saved.error === "RADAR_SESSION_REQUIRED"
    )
      throw deviceError(saved.error);

    // Radar session found
    if (typeof saved.radar_session === "string")
      return { radar_session: saved.radar_session };

    // Radar session not found, but fallback was found
    if (isRecord(saved.data) && typeof saved.data.ip === "string") {
      return {
        data: {
          ip: saved.data.ip,
          ...(typeof saved.data.user_agent === "string"
            ? { user_agent: saved.data.user_agent }
            : {}),
          ...(typeof saved.data.referrer === "string"
            ? { referrer: saved.data.referrer }
            : {}),
        },
      };
    }

    // Nothing was found, default to current-request details
    return deviceDetailsFromRequest(ctx);
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
      clientDetails = await evaluationDeviceDetails(ctx);
    } catch (error) {
      return handleEvaluationError(
        error,
        ctx,
        isAPIError(error) ? error : undefined,
      );
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
      return handleEvaluationError(error, ctx);
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
    try {
      requestState(ctx).pending = pending;
    } catch (error) {
      await handleEvaluationError(error, ctx);
    }
  }

  return {
    id: "account-evaluations",
    version: "0.1.3",
    init() {
      return {
        options: {
          databaseHooks: {
            user: {
              create: {
                async before(user, ctx) {
                  if (!ctx || !isProtectedPath(ctx.path)) return;
                  try {
                    requestState(ctx).registration = true;
                  } catch (error) {
                    return handleEvaluationError(error, ctx);
                  }
                  await evaluate(user, "registration", ctx);
                },
              },
            },
            session: {
              create: {
                async before(session, ctx) {
                  if (!ctx || !isProtectedPath(ctx.path)) return;
                  let user;
                  try {
                    if (requestState(ctx).registration) return;
                    user = await ctx.context.internalAdapter.findUserById(
                      session.userId,
                    );
                    if (!user)
                      throw new Error(
                        "Account evaluation user could not be resolved.",
                      );
                  } catch (error) {
                    return handleEvaluationError(error, ctx);
                  }
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
          matcher: (ctx) => isProtectedPath(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            try {
              // Initialize the request state for all protected paths
              (ctx.context as StateContext).accountEvaluationsState =
                new RequestState();

              // Only redirect-based social sign-in needs to preserve evidence.
              if (ctx.path !== "/sign-in/social" || ctx.body?.idToken) return;

              let device;
              try {
                device = deviceDetailsFromRequest(ctx);
              } catch (error) {
                if (!isAPIError(error)) throw error;
                device = { error: error.body?.code };
              }
              await addOAuthServerContext({ accountEvaluationsDevice: device });
            } catch (error) {
              await handleEvaluationError(error, ctx);
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => isProtectedPath(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            try {
              const state = (ctx.context as StateContext)
                .accountEvaluationsState;
              const pending = state?.pending;
              if (!pending) return;
              state.pending = undefined;
              const result = ctx.context.returned;
              // Report allowed only after auth succeeds.
              const authenticated = isSocialCallback(ctx.path)
                ? ctx.context.newSession &&
                  isAPIError(result) &&
                  result.statusCode === 302
                : isRecord(result) && "user" in result && !isAPIError(result);
              if (authenticated) {
                await report(pending, ctx);
              }
            } catch (error) {
              // Reporting runs after authentication; never turn it into a failure.
              await notifyError({ operation: "report", error }, ctx);
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
