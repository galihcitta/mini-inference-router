import { expect, test, type Page } from "@playwright/test";

// On-screen caption so the recording explains itself.
async function caption(page: Page, title: string, detail = "") {
  await page.evaluate(([t, d]) => {
    let el = document.getElementById("e2e-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "e2e-caption";
      el.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:99999;max-width:520px;padding:12px 16px;border-radius:10px;background:#111827ee;color:#f9fafb;font:14px/1.4 system-ui;box-shadow:0 4px 18px #0006";
      document.body.appendChild(el);
    }
    el.innerHTML = `<div style="font-weight:600;font-size:15px">${t}</div>${d ? `<div style="opacity:.85;margin-top:4px">${d}</div>` : ""}`;
  }, [title, detail]);
}

const hold = (page: Page, ms = 1800) => page.waitForTimeout(ms);
const verdict = (page: Page) => page.locator(".verdict");
const trace = (page: Page) => page.locator(".inspect");

async function send(page: Page) {
  const response = page.waitForResponse((r) => r.url().includes("/v1/"));
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await response;
  await expect(verdict(page)).not.toHaveClass(/is-running/);
}

async function scenario(page: Page, title: string) {
  await page.getByRole("button", { name: new RegExp(`^${title}`) }).click();
  await send(page);
}

test("console walkthrough: routing, fallback, refusals, quota, auth, usage", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Demo mode")).toBeVisible();

  await test.step("1. Normal path: Haiku answers", async () => {
    await caption(page, "1. A normal question (tenant acme)", "Route Haiku → Sonnet → backup. Haiku should answer first try, intent cancel order.");
    await scenario(page, "A normal question");
    await expect(verdict(page)).toContainText("Haiku 5.5 answered on the first try");
    await expect(page.locator(".stats")).toContainText("cancel order");
    await expect(page.locator(".answer-text")).not.toContainText("No answer yet");
    await hold(page, 2500);
  });

  await test.step("2. Model labels the message out of scope", async () => {
    await caption(page, "2. Off-topic but sounds close", "Retrieval finds weak matches, so Haiku is asked; it labels the message out of scope and the gateway refuses.");
    await scenario(page, "Off-topic but sounds close");
    await expect(verdict(page)).toContainText("outside customer support");
    await hold(page);
  });

  await test.step("3. Out of domain, refused before any model call", async () => {
    await caption(page, "3. Clearly off-topic", "Best retrieval score is below the threshold (4): refused with no model call, so $0.");
    await scenario(page, "Clearly off-topic");
    await expect(verdict(page)).toContainText("Refused without calling a model");
    await expect(trace(page)).toContainText("No model was called");
    await hold(page);
  });

  await test.step("4. Haiku too slow: fallback to Sonnet", async () => {
    await caption(page, "4. First model too slow (tenant slow-haiku)", "Haiku gets 50 ms to start, times out, and Sonnet serves. The route trace shows both attempts.");
    await scenario(page, "First model too slow");
    await expect(verdict(page)).toContainText(/Sonnet 5\.5 answered after Haiku 5\.5 sent nothing/);
    await expect(trace(page).locator(".trace-row")).toHaveCount(2);
    await hold(page, 2500);
  });

  await test.step("5. Both real models down: backup serves", async () => {
    await caption(page, "5. Both models down (tenant outage)", "Haiku and Sonnet both time out; the backup answers from the closest stored reply.");
    await scenario(page, "Both models down");
    await expect(verdict(page)).toContainText("Backup answered after Haiku 5.5 and Sonnet 5.5 both");
    await expect(trace(page).locator(".trace-row")).toHaveCount(3);
    await hold(page, 2500);
  });

  await test.step("6. Raw gateway chat endpoint", async () => {
    await caption(page, "6. Raw gateway chat (/v1/chat)", "Same gateway (auth, quota, routing, metering) without retrieval or intent.");
    await scenario(page, "Raw gateway chat");
    await expect(verdict(page)).toContainText("Haiku 5.5 answered");
    await hold(page);
  });

  await test.step("7. Quota fails closed", async () => {
    await caption(page, "7. Out of budget (tenant tiny, $0.0005)", "The first request fits the budget; the second gets HTTP 429 instead of a free backup answer.");
    await scenario(page, "Out of budget");
    await expect(verdict(page)).toContainText("answered");
    await hold(page, 1200);
    await send(page);
    await expect(verdict(page)).toContainText("Blocked before anything ran");
    await expect(page.locator(".alert")).toContainText("429");
    await hold(page);
  });

  await test.step("8. Unknown key is rejected", async () => {
    await caption(page, "8. Auth", "An unknown API key gets HTTP 401 before anything else runs.");
    await page.getByRole("button", { name: "Use my own key" }).click();
    await page.getByLabel("Tenant API key").fill("mir_notarealkey000000000000000000000000");
    await send(page);
    await expect(verdict(page)).toContainText("Rejected at the door");
    await expect(page.locator(".alert")).toContainText("401");
    await hold(page);
  });

  await test.step("9. Usage view: cost, budget and the stored trace", async () => {
    await caption(page, "9. Usage", "Requests, spend and budget per tenant, then the stored route trace of a fallback request.");
    await page.getByRole("button", { name: "Usage" }).click();
    const tenantRow = page.locator("table.tenants tr.clickable", { hasText: "slow-haiku" });
    await expect(tenantRow).toBeVisible();
    await hold(page, 2000);
    await tenantRow.click();
    const row = page.locator("table.request-table tr.clickable").first();
    await expect(row).toContainText("fallback");
    await row.click();
    await expect(page.locator("tr.detail")).toContainText("Sent nothing before its time limit");
    await hold(page, 3000);
    await caption(page, "Done", "All 9 checks passed against the real server, Postgres, Haiku 5.5 and Sonnet 5.5.");
    await hold(page, 2000);
  });
});
