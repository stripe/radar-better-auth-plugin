"use client";

import { createAuthClient } from "better-auth/react";
import { accountEvaluationsClient } from "@stripe/radar-better-auth/client";

export function makeAuthClient(mock: boolean) {
  return createAuthClient({
    plugins: [
      accountEvaluationsClient(
        mock
          ? {
              createRadarSession: async () =>
                `rse_mock${crypto.randomUUID().replaceAll("-", "")}`,
            }
          : {
              publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!,
            },
      ),
    ],
  });
}
