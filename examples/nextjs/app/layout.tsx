import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Account Evaluations · Better Auth",
  description:
    "A working example of Stripe Account Evaluations with Better Auth and Next.js.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
