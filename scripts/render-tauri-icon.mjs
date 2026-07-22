import { chromium } from "@playwright/test";
import { resolve } from "node:path";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
await page.goto(`file://${resolve("src-tauri/icons/icon.svg")}`);
await page.screenshot({ path: resolve("src-tauri/icons/icon.png"), omitBackground: true });
await browser.close();
