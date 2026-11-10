import { expect, test } from "@playwright/test";

test("sign up, sign out, sign in, and reject a high-risk account", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Make yourself at home." }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/example-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Normal 20/100" }).click();
  await page.getByLabel("Full name").fill("Alex Morgan");
  await page
    .getByLabel("Password", { exact: true })
    .fill("a-long-test-password");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("heading", { name: "You’re in, Alex." }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "You’re in, Alex." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("button", { name: "Sign in", exact: true })
    .first()
    .click();
  await page
    .getByLabel("Email address")
    .fill("normal_scoring_email@example.com");
  await page
    .getByLabel("Password", { exact: true })
    .fill("a-long-test-password");
  await page
    .getByRole("button", { name: "Sign in", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("heading", { name: "You’re in, Alex." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Highest 80/100" }).click();
  await page.getByLabel("Full name").fill("Alex Morgan");
  await page
    .getByLabel("Password", { exact: true })
    .fill("a-long-test-password");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .last()
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "We couldn't complete this request" }),
  ).toBeVisible();
  await expect(page.getByLabel("Email address")).toBeVisible();
  const session = await page.request.get("/api/auth/get-session");
  expect(await session.json()).toBeNull();
});

test("fits a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByLabel("Full name")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/example-mobile.png",
    fullPage: true,
  });
});
