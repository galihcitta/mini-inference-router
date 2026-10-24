import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// Fresh keys and reset quotas for every run.
const keys: Record<string, string> = Object.fromEntries(
  execSync("npx tsx --env-file=.env scripts/seed.ts", { encoding: "utf8" })
    .split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => p[1]?.startsWith("mir_")),
);
const adminToken = /^ADMIN_TOKEN=(.+)$/m.exec(readFileSync(".env", "utf8"))![1].trim();

// On-screen caption so the recording explains itself.
async function caption(page: Page, title: string, detail = "") {
  await page.evaluate(([t, d]) => {
    let el = document.getElementById("e2e-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "e2e-caption";
      el.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:99999;max-width:560px;padding:12px 16px;border-radius:10px;background:#111827ee;color:#f9fafb;font:14px/1.4 system-ui;box-shadow:0 4px 18px #0006";
      document.body.appendChild(el);
    }
    el.innerHTML = `<div style="font-weight:600;font-size:15px">${t}</div>${d ? `<div style="opacity:.85;margin-top:4px">${d}</div>` : ""}`;
  }, [title, detail]);
}

const details = (page: Page) => page.locator("h2", { hasText: "Request details" }).locator("..");
const hold = (page: Page, ms = 1800) => page.waitForTimeout(ms);

async function ask(page: Page, tenant: string, message: string, endpoint: "/v1/support/chat" | "/v1/chat" = "/v1/support/chat") {
  await page.getByLabel("Tenant API key").fill(keys[tenant] ?? tenant);
  await page.getByRole("radio", { name: endpoint }).check();
  const box = page.getByLabel("Message");
  await box.fill("");
  await box.pressSequentially(message, { delay: 15 });
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("streaming…")).toBeHidden();
}

test("console walkthrough: routing, fallback, refusals, quota, auth, usage", async ({ page }) => {
  await page.goto("/");

  await test.step("1. Normal path: Haiku answers", async () => {
    await caption(page, "1. Normal path (tenant acme)", "Route Haiku → Sonnet → mock. Expect Haiku to answer with intent cancel_order and no fallback.");
    await ask(page, "acme", "Hi, I ordered the wrong size. Please cancel order ORD-10482.");
    await expect(details(page)).toContainText("haiku");
    await expect(details(page)).toContainText("cancel_order");
    await expect(page.getByText(/Fallback fired/)).toHaveCount(0);
    await expect(page.locator(".answer")).not.toContainText("No answer yet");
    await hold(page, 2500);
  });

  await test.step("2. Model labels the message out_of_scope", async () => {
    await caption(page, "2. Out of scope, caught by the model", "Retrieval finds a weak lexical match, so Haiku is called; it labels the message out_of_scope and the gateway refuses.");
    await ask(page, "acme", "tell me a joke about cats");
    await expect(page.getByText(/Refused: out_of_scope/)).toBeVisible();
    await hold(page);
  });

  await test.step("3. Out of domain, refused before any model call", async () => {
    await caption(page, "3. Out of domain, caught by retrieval", "Top BM25 score below the threshold (4): refused with no model call, so no backend and $0.");
    await ask(page, "acme", "explain how black holes form");
    await expect(page.getByText(/Refused: no close match/)).toBeVisible();
    await hold(page);
  });

  await test.step("4. Haiku too slow: fallback to Sonnet", async () => {
    await caption(page, "4. Fallback to Sonnet (tenant slow-haiku)", "Haiku's first-token timeout is 50 ms for this tenant, so it times out and Sonnet serves. The attempt trail records both.");
    await ask(page, "slow-haiku", "Where is my refund? It has been two weeks.");
    await expect(page.getByText("Fallback fired (2 attempts)")).toBeVisible();
    await expect(details(page)).toContainText("timeout_first_token");
    await expect(details(page)).toContainText("sonnet");
    await hold(page, 2500);
  });

  await test.step("5. Both real models down: mock serves", async () => {
    await caption(page, "5. Last resort (tenant outage)", "Haiku and Sonnet both time out; the extractive mock answers from the top retrieved entry.");
    await ask(page, "outage", "How do I change my shipping address?");
    await expect(page.getByText("Fallback fired (3 attempts)")).toBeVisible();
    await expect(details(page)).toContainText("mock");
    await hold(page, 2500);
  });

  await test.step("6. Raw gateway chat endpoint", async () => {
    await caption(page, "6. Raw gateway endpoint /v1/chat", "Same gateway (auth, quota, routing, metering) without retrieval.");
    await ask(page, "acme", "Say hello in exactly five words.", "/v1/chat");
    await expect(details(page)).toContainText("haiku");
    await hold(page);
  });

  await test.step("7. Quota fails closed", async () => {
    await caption(page, "7. Quota fails closed (tenant tiny, $0.0005)", "First request fits the budget; the second gets HTTP 429 quota_exceeded instead of a free fallback answer.");
    await ask(page, "tiny", "How do I get my invoice?");
    await expect(details(page)).toContainText("haiku");
    await hold(page, 1200);
    await ask(page, "tiny", "How do I get my invoice?");
    await expect(page.locator(".alert")).toContainText(/429|quota/i);
    await hold(page);
  });

  await test.step("8. Unknown key is rejected", async () => {
    await caption(page, "8. Auth", "An unknown API key gets HTTP 401 before anything else runs.");
    await ask(page, "mir_notarealkey000000000000000000000000", "How do I get my invoice?");
    await expect(page.locator(".alert")).toContainText(/401|unauthorized/i);
    await hold(page);
  });

  await test.step("9. Usage view: cost, quota and the recorded trail", async () => {
    await caption(page, "9. Usage view (admin)", "Requests, cost and remaining quota per tenant, then the stored attempt trail for a fallback request.");
    await page.getByRole("button", { name: "Usage" }).click();
    await page.getByLabel("Admin token").fill(adminToken);
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByRole("cell", { name: "acme", exact: true })).toBeVisible();
    await hold(page, 2000);
    await page.getByRole("cell", { name: "slow-haiku", exact: true }).click();
    const row = page.locator("table").nth(1).locator("tr.clickable").first();
    await expect(row).toContainText("fallback");
    await row.click();
    await expect(page.locator("tr.detail")).toContainText("timeout_first_token");
    await hold(page, 3000);
    await caption(page, "Done", "All 9 checks passed against the real server, Postgres, Haiku 5.5 and Sonnet 5.5.");
    await hold(page, 2000);
  });
});
