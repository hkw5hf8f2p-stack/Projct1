/**
 * Піднімає фікстурні сайти на фіксованих портах для прогонів через API (README «Швидкий старт», сценарії S2):
 * shop :B, shop-clean :B+1, bot :B+2, errors :B+3 (HTTPS :B+4), де B = FIXTURE_BASE_PORT (типово 4210). Зупинка — SIGTERM/Ctrl+C. Лише 127.0.0.1.
 */
import { createShopCleanHandler } from "../fixtures/shop-clean/server.js";
import { createShopHandler } from "../fixtures/shop/server.js";
import { startFixtureServer } from "../fixtures/_shared/server.js";
import { startBotFixture } from "../fixtures/bot/server.js";
import { startErrorsFixture } from "../fixtures/errors/server.js";
import { newPidFile, writePidFile } from "../packages/db/src/index.js";
import { rmSync } from "node:fs";
import path from "node:path";

const B = Number(process.env["FIXTURE_BASE_PORT"] ?? 4210);
const shop = await startFixtureServer({ handler: createShopHandler({ mutant: null, control: null, transforms: null }), port: B });
const clean = await startFixtureServer({ handler: createShopCleanHandler({ transforms: null }), port: B + 1 });
const bot = await startBotFixture({ port: B + 2 });
const errors = await startErrorsFixture({ port: B + 3, httpsPort: B + 4 });
writePidFile(path.join(process.env["PID_DIR"] ?? path.resolve(import.meta.dirname, "../data/pids"), "fixtures.json"), newPidFile("fixtures", process.pid, []));
console.log(JSON.stringify({ shop: shop.origin, clean: clean.origin, bot: bot.origin, errors: errors.origin, errors_https: errors.httpsOrigin }));
const stop = async () => { await Promise.all([shop.close(), clean.close(), bot.close(), errors.close()]); rmSync(path.join(process.env["PID_DIR"] ?? path.resolve(import.meta.dirname, "../data/pids"), "fixtures.json"), { force: true }); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
