import { randomUUID } from "node:crypto";
import type { AccountEvaluationsClient } from "@stripe/radar-better-auth";

/** Deterministic local-only Customer mapping; these IDs are never sent to Stripe. */
export async function resolveMockCustomer(user: { email: string }) {
  return `cus_mock${Buffer.from(user.email).toString("hex")}`;
}

/** Local score fixtures. */
export const mockStripe: AccountEvaluationsClient = {
  async evaluate({ customerId, contactEmail, activity }) {
    const email =
      contactEmail ??
      (customerId?.startsWith("cus_mock")
        ? Buffer.from(customerId.slice("cus_mock".length), "hex").toString()
        : "");
    const score = email.includes("high_scoring_email")
      ? 80
      : email.includes("elevated_scoring_email")
        ? 65
        : 20;
    return {
      id: `acctevl_mock${randomUUID().replaceAll("-", "")}`,
      signal:
        activity === "registration"
          ? "user_multi_accounting"
          : "user_account_sharing",
      score,
      riskLevel: score >= 75 ? "highest" : score >= 65 ? "elevated" : "normal",
    };
  },
  async reportDecision() {
    // onDecision logs mock outcomes.
  },
};
