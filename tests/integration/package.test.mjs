import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { accountEvaluations } from "@stripe/radar-better-auth";

test("built server entry point loads in native Node ESM", () => {
  const plugin = accountEvaluations({
    client: {
      async evaluate() {
        throw new Error("This import check should not evaluate accounts");
      },
      async reportDecision() {},
    },
  });
  assert.equal(plugin.id, "account-evaluations");
});

test("built browser client bundles and attaches device context", async () => {
  const bundle = await build({
    stdin: {
      contents: `
        export { createAuthClient } from "better-auth/client";
        export { accountEvaluationsClient } from "@stripe/radar-better-auth/client";
      `,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
  });
  // Execute the browser bundle with a custom collector and fetch implementation.
  // Direct Node resolution of the browser entry point is not required.
  const { createAuthClient, accountEvaluationsClient } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  let calls = 0;
  const client = createAuthClient({
    baseURL: "http://localhost:3000",
    plugins: [
      accountEvaluationsClient({
        createRadarSession: async () => "rse_packagecheck",
      }),
    ],
    fetchOptions: {
      customFetchImpl: async (_url, init) => {
        calls++;
        assert.equal(
          new Headers(init.headers).get("x-stripe-radar-session"),
          "rse_packagecheck",
        );
        return Response.json({ ok: true });
      },
    },
  });
  const result = await client.signIn.email({
    email: "test@example.com",
    password: "package-test-password",
  });
  assert.equal(result.error, null);
  assert.equal(calls, 1);
});
