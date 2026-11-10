import type { BetterAuthClientPlugin } from "better-auth/client";
import { loadStripe } from "@stripe/stripe-js/pure";
import type { accountEvaluations } from "./index.js";
import { RADAR_SESSION_HEADER, protectedPaths } from "./shared.js";

export { RADAR_SESSION_HEADER } from "./shared.js";

export type AccountEvaluationsClientOptions = (
  | {
      /** Loads Stripe.js for Radar collection. */
      publishableKey: string;
      createRadarSession?: never;
    }
  | {
      /** Custom Radar collector. */
      createRadarSession: () => Promise<string | undefined>;
      publishableKey?: never;
    }
) & {
  /** Preload one browser session. Default: true. */
  preload?: boolean;
  /** Collection timeout. Default: 10 seconds. */
  timeoutMs?: number;
};

export function accountEvaluationsClient(
  options: AccountEvaluationsClientOptions,
) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("timeoutMs must be a positive integer.");
  if (
    !options.createRadarSession &&
    !options.publishableKey?.startsWith("pk_")
  ) {
    throw new Error("A Stripe publishableKey is required.");
  }
  let stripePromise: ReturnType<typeof loadStripe> | undefined;
  const createRadarSession =
    options.createRadarSession ??
    (async () => {
      stripePromise ??= loadStripe(options.publishableKey!).catch((error) => {
        stripePromise = undefined;
        throw error;
      });
      const stripe = await stripePromise;
      if (!stripe) {
        stripePromise = undefined;
        throw new Error("Stripe.js could not load. Please try again.");
      }
      const result = await stripe.createRadarSession();
      if (result.error)
        throw new Error("Device verification failed. Please try again.");
      return result.radarSession.id;
    });

  async function collectRadarSession() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const session = await Promise.race([
        createRadarSession(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error("Device verification timed out. Please try again."),
              ),
            timeoutMs,
          );
        }),
      ]);
      if (!session || !/^rse_[a-zA-Z0-9_]{1,250}$/.test(session))
        throw new Error("Device verification failed. Please try again.");
      return session;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  let preloadedSession: Promise<string> | undefined;
  if (options.preload !== false && typeof window !== "undefined") {
    preloadedSession = collectRadarSession();
    void preloadedSession.catch(() => {
      preloadedSession = undefined;
    });
  }

  return {
    id: "account-evaluations",
    $InferServerPlugin: {} as ReturnType<typeof accountEvaluations>,
    fetchPlugins: [
      {
        id: "account-evaluations-radar-session",
        name: "Account Evaluations Radar Session",
        hooks: {
          async onRequest(ctx) {
            const pathname = new URL(ctx.url, "http://localhost").pathname;
            if (
              !protectedPaths.some((path) => pathname.endsWith(path)) ||
              ctx.method.toUpperCase() !== "POST"
            )
              return;
            // Discard caller tokens to avoid reuse.
            const headers = new Headers(ctx.headers);
            headers.delete(RADAR_SESSION_HEADER);
            try {
              const pending = preloadedSession ?? collectRadarSession();
              preloadedSession = undefined;
              headers.set(RADAR_SESSION_HEADER, await pending);
            } catch {
              // The server derives sessionless details from the request.
            }
            return { ...ctx, headers };
          },
        },
      },
    ],
  } satisfies BetterAuthClientPlugin;
}
