import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright";

const artifacts = fileURLToPath(
  new URL(
    `../../../output/playwright/ui-${new Date().toISOString().replaceAll(":", "-")}/`,
    import.meta.url,
  ),
);
await mkdir(artifacts, { recursive: true });
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("./fixture", import.meta.url)),
  plugins: [react(), tailwindcss()],
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
let page;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.UI_BROWSER_CHANNEL
      ? { channel: process.env.UI_BROWSER_CHANNEL }
      : {}),
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  for (const compact of [false, true]) {
    const appearance = compact ? "compact" : "default";
    await page.goto(
      `${server.resolvedUrls.local[0]}${compact ? "?compact" : ""}`,
    );
    const input = page.getByRole("textbox", { name: "Message the agent" });
    await input.waitFor({ state: "visible" });
    assert.equal(
      await page.getByRole("region", { name: "Activity fixture" }).count(),
      1,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .isDisabled(),
      true,
    );
    const count = async (value) => {
      await page.waitForFunction(
        (expected) =>
          document.querySelector('[aria-label="Submissions"]').textContent ===
          String(expected),
        value,
      );
    };

    await input.fill("first draft");
    await input.press("Shift+Enter");
    await count(0);
    assert.match(await input.inputValue(), /\n/);
    await input.dispatchEvent("compositionstart");
    await input.press("Enter");
    await count(0);
    await input.dispatchEvent("compositionend");
    await input.fill("first draft");
    await input.press("Enter");
    await count(1);
    await input.press("Enter");
    await count(1);
    // Editing back to the same text still represents a newer revision.
    await input.fill("newer draft");
    await input.fill("first draft");
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    assert.equal(await input.inputValue(), "first draft");
    await input.press("Enter");
    await count(2);
    await page
      .getByRole("button", { name: "Switch room", exact: true })
      .click();
    await input.fill("room b draft");
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    assert.equal(await input.inputValue(), "room b draft");

    await input.press("Enter");
    await count(3);
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    assert.equal(await input.inputValue(), "room b draft");
    await input.press("Enter");
    await count(4);
    await page.getByRole("button", { name: "Fail", exact: true }).click();
    await page.getByText("Could not send.", { exact: false }).waitFor();
    assert.equal(await input.inputValue(), "room b draft");
    await input.press("Enter");
    await count(5);
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    assert.equal(await input.inputValue(), "");

    if (!compact) {
      await input.fill("x".repeat(4001));
      await page
        .getByText("Prompt must be 4,000 characters or fewer.")
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Send message", exact: true })
          .isDisabled(),
        true,
      );
    } else assert.equal(await input.getAttribute("maxlength"), "8000");
    await input.fill("Preserve this draft while resizing.");
    const sam = page.getByRole("checkbox", {
      name: "Select message from Sam",
      exact: true,
    });
    await sam.click();
    assert.equal(await sam.isChecked(), true);
    const alex = page.getByRole("checkbox", {
      name: "Select message from Alex",
      exact: true,
    });
    assert.equal(await alex.nth(1).isDisabled(), true);
    assert.equal(await alex.nth(2).isDisabled(), true);
    await page.getByText("Failed to send", { exact: true }).waitFor();
    await page.keyboard.press("Control+b");
    await page
      .getByRole("button", { name: "Sidebar closed", exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("Persisted sidebar").textContent(),
      "false",
    );
    assert.equal(await page.evaluate(() => document.cookie), "");

    const splitter = page.getByRole("separator", {
      name: "Resize activity and chat panels",
    });
    await splitter.focus();
    const activity = page.getByRole("region", { name: "Activity fixture" });
    const widthBefore = (await activity.boundingBox()).width;
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(
      (before) =>
        document
          .querySelector('[aria-label="Activity fixture"]')
          .getBoundingClientRect().width !== before,
      widthBefore,
    );
    assert.equal(
      await input.inputValue(),
      "Preserve this draft while resizing.",
    );
    await page.screenshot({
      path: `${artifacts}/${appearance}.png`,
      fullPage: true,
    });
    if (!compact) {
      await page.setViewportSize({ width: 390, height: 844 });
      await splitter.waitFor({ state: "hidden" });
      const a = await activity.boundingBox();
      const c = await page
        .getByRole("region", { name: "Chat fixture" })
        .boundingBox();
      assert.ok(c.y >= a.y + a.height - 1, "mobile panels should stack");
      assert.equal(
        await input.inputValue(),
        "Preserve this draft while resizing.",
      );
      assert.equal(await sam.isChecked(), true);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: `${artifacts}/mobile.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    console.log(
      `PASS: ${appearance} composer acknowledgments, revisions, rooms, failures, IME, chat selection, sidebar persistence and resizing`,
    );
  }
  assert.deepEqual(errors, [], "browser console must be clean");
  console.log(`Artifacts: ${artifacts}`);
} catch (error) {
  await page
    ?.screenshot({ path: `${artifacts}/failure.png`, fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  await writeFile(`${artifacts}/console.json`, JSON.stringify(errors, null, 2));
  await browser?.close();
  await server.close();
}
