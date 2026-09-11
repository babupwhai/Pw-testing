import { expect, test } from "@playwright/test";

test("Owner login remains visible after hydration", async ({ page }) => {
  const consoleErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto("/auth", { waitUntil: "domcontentloaded" });

  const form = page.locator("form");
  const loginButton = page.getByRole("button", { name: "Login", exact: true });

  await expect(page.getByRole("heading", { name: "Owner login" })).toBeVisible();
  await expect(form).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();

  // The button is server-rendered as disabled and enabled only after React hydrates.
  await expect(loginButton).toBeEnabled();
  await page.waitForTimeout(250);

  expect(consoleErrors, `Browser console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});