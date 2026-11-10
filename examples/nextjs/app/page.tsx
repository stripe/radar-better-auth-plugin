import { AuthDemo } from "@/components/auth-demo";

export const dynamic = "force-dynamic";

export default function Page() {
  const mock = process.env.ACCOUNT_EVALUATIONS_MODE === "mock";
  const monitor = process.env.ACCOUNT_EVALUATIONS_POLICY === "monitor";
  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Account Evaluations home">
          <span className="brand-mark">
            a<span>e</span>
          </span>
          Account evaluations
        </a>
        <span className="integration-label">
          Stripe Radar <span>×</span> Better Auth
        </span>
      </header>
      <section className="demo-grid">
        <div className="intro">
          <div className="eyebrow">
            <span className="status-dot" /> A BETTER AUTH PLUGIN
          </div>
          <h1>
            A little context.
            <br />A smarter
            <br />
            <span>front door.</span>
          </h1>
          <p className="lede">
            Evaluate account risk at signup and login. Give legitimate users a
            clear path in, and catch suspicious activity early.
          </p>
          <div className="flow" aria-label="Integration steps">
            <div>
              <span className="step-number">01</span>
              <p>
                <strong>Collect device context</strong>
                <span>A fresh Radar Session for each attempt.</span>
              </p>
            </div>
            <div>
              <span className="step-number">02</span>
              <p>
                <strong>Evaluate the account</strong>
                <span>Check multi-accounting or account-sharing risk.</span>
              </p>
            </div>
            <div>
              <span className="step-number">03</span>
              <p>
                <strong>Act and report</strong>
                <span>Apply your policy and send Stripe the outcome.</span>
              </p>
            </div>
          </div>
          <a
            className="docs-link"
            href="https://better-auth.com/docs/guides/your-first-plugin"
            target="_blank"
            rel="noreferrer"
          >
            Built with Better Auth <span aria-hidden="true">↗</span>
          </a>
        </div>
        <div className="demo-column">
          <div className="demo-meta">
            <span className="mode-tag">
              <span className="status-dot" />
              {mock ? "LOCAL MOCK" : "STRIPE API"}
            </span>
            <span>{monitor ? "Monitor policy" : "Block at score ≥ 75"}</span>
          </div>
          <AuthDemo mock={mock} monitor={monitor} />
          <p className="demo-footnote">
            {mock
              ? "Mock mode uses fixed scores. No data is sent to Stripe."
              : "Device context and account details are sent to Stripe for evaluation."}
          </p>
        </div>
      </section>
      <footer>
        <span>Next.js example / v0.1</span>
        <span>Account intelligence, before the payment.</span>
      </footer>
    </main>
  );
}
