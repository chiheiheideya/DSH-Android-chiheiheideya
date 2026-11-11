// Regression for patch 13 (issue #7): saving an image must not fail when an ancestor of
// DSH_HOME is unreadable to the app uid, as `/data/user/0` is on Android.
// Usage: node js/test/attachment-dir-sync.test.mjs <stage>/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js
import { mkdirSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
const mod = process.argv[2]; const base = mkdtempSync(join(tmpdir(), "dsh-att-")); const plat = "android";
if (plat) Object.defineProperty(process, "platform", { value: plat });
const { saveImageFile } = await import(mod);
rmSync(base, { recursive: true, force: true });
const locked = join(base, "user0"); const home = join(locked, "app", "files", "dsh");
mkdirSync(home, { recursive: true }); chmodSync(locked, 0o311); // like /data/user/0: no read for us
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const limits = { maxImageBytes: 2e7, maxImagesPerMessage: 20, maxMessageImageBytes: 2e8, maxImagePixels: 64e6, maxImageDimension: 8192, mediaTypes: ["image/png","image/jpeg"] };
const policy = { maxPixels: 4194304, maxDimension: 8192, maxBytes: 4194304 };
try { const r = await saveImageFile(join(home, "attachments", "v1"), { name: "a.png", mediaType: "image/png", data: png }, limits, policy); console.log("PASS image saved under an unreadable ancestor"); }
catch (e) { console.log("FAIL", e.code, e.message); process.exitCode = 1; }
finally { chmodSync(locked, 0o755); rmSync(base, { recursive: true, force: true }); }
