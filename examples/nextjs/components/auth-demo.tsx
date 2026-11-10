"use client";

import { useMemo, useState } from "react";
import { makeAuthClient } from "@/lib/auth-client";

const scenarios = [
  { label: "Normal", score: 20, email: "normal_scoring_email@example.com" },
  { label: "Elevated", score: 65, email: "elevated_scoring_email@example.com" },
  { label: "Highest", score: 80, email: "high_scoring_email@example.com" },
];

export function AuthDemo({
  mock,
  monitor,
}: {
  mock: boolean;
  monitor: boolean;
}) {
  const client = useMemo(() => makeAuthClient(mock), [mock]);
  const { data: session, isPending } = client.useSession();
  const [tab, setTab] = useState<"signup" | "login">("signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);
  const selected = scenarios.find((scenario) => scenario.email === email);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result =
        tab === "signup"
          ? await client.signUp.email({ name, email, password })
          : await client.signIn.email({ email, password });
      if (result.error) {
        setMessage({
          kind: "error",
          text:
            result.error.message ?? "Authentication failed. Please try again.",
        });
      } else {
        setPassword("");
        setMessage({
          kind: "success",
          text:
            tab === "signup"
              ? "Your account is ready. Welcome in."
              : "You’re signed in. Welcome back.",
        });
      }
    } catch (error) {
      setMessage({
        kind: "error",
        text:
          error instanceof Error
            ? error.message
            : "Something went wrong. Please try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await client.signOut();
      if (result.error)
        setMessage({
          kind: "error",
          text: result.error.message ?? "Could not sign out.",
        });
    } catch {
      setMessage({
        kind: "error",
        text: "Could not sign out. Please try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-card">
      <div className="card-heading">
        <span className="card-icon" aria-hidden="true">
          ↗
        </span>
        <span>THE EXAMPLE APP</span>
      </div>
      {isPending ? (
        <p role="status" className="loading">
          Checking your session…
        </p>
      ) : session ? (
        <div className="signed-in">
          <span className="success-icon" aria-hidden="true">
            ✓
          </span>
          <h2>You’re in, {session.user.name.split(" ")[0]}.</h2>
          <p className="card-description">
            Your account passed the configured policy and Better Auth created a
            session.
          </p>
          <dl className="session-details">
            <div>
              <dt>Account</dt>
              <dd>{session.user.email}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <span className="active-badge">Signed in</span>
              </dd>
            </div>
          </dl>
          <button className="primary-button" onClick={signOut} disabled={busy}>
            {busy ? "Signing out…" : "Sign out"}
          </button>
          <p className="small-note">
            Sign out to try another account or test the login flow.
          </p>
        </div>
      ) : (
        <>
          <h2>
            {tab === "signup"
              ? "Make yourself at home."
              : "Good to see you again."}
          </h2>
          <p className="card-description">
            {tab === "signup"
              ? "Create an account to try the evaluation flow."
              : "Sign in to evaluate account-sharing risk."}
          </p>
          <div className="tabs" aria-label="Authentication mode">
            <button
              type="button"
              aria-pressed={tab === "signup"}
              onClick={() => {
                setTab("signup");
                setMessage(null);
              }}
              disabled={busy}
            >
              Create account
            </button>
            <button
              type="button"
              aria-pressed={tab === "login"}
              onClick={() => {
                setTab("login");
                setMessage(null);
              }}
              disabled={busy}
            >
              Sign in
            </button>
          </div>
          <form onSubmit={submit}>
            <fieldset disabled={busy}>
              {tab === "signup" && (
                <label>
                  Full name
                  <input
                    required
                    name="name"
                    autoComplete="name"
                    placeholder="Alex Morgan"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
              )}
              <label>
                Email address
                <input
                  required
                  type="email"
                  name="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label>
                Password
                <input
                  required
                  type="password"
                  name="password"
                  minLength={12}
                  autoComplete={
                    tab === "signup" ? "new-password" : "current-password"
                  }
                  placeholder="At least 12 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <button className="primary-button" type="submit">
                {busy
                  ? "Checking your account…"
                  : tab === "signup"
                    ? "Create account"
                    : "Sign in"}
                <span aria-hidden="true">→</span>
              </button>
            </fieldset>
          </form>
          {mock && (
            <div className="scenarios">
              <div className="scenario-heading">
                <span>TRY A RISK LEVEL</span>
                <span>Mock fixtures</span>
              </div>
              <div className="scenario-buttons">
                {scenarios.map((scenario) => (
                  <button
                    key={scenario.score}
                    type="button"
                    disabled={busy}
                    aria-pressed={selected?.score === scenario.score}
                    onClick={() => {
                      setEmail(scenario.email);
                      setMessage(null);
                    }}
                  >
                    <span>{scenario.label}</span>
                    <strong>
                      {scenario.score}
                      <span>/100</span>
                    </strong>
                  </button>
                ))}
              </div>
              <p>
                {selected
                  ? `${selected.label} risk: ${selected.score >= 75 && !monitor ? "this attempt will be blocked" : "this attempt will be allowed"}.`
                  : "Choose a fixture to fill in its email address."}{" "}
                {tab === "login" && "Create the account first."}
              </p>
            </div>
          )}
        </>
      )}
      {message && (
        <div
          className={`message ${message.kind}`}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}
