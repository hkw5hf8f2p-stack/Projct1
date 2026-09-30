/**
 * Піднімає фікстурні сайти на фіксованих портах для прогонів через API (README «Швидкий старт», сценарії S2):
 * shop :4210, shop-clean :4211, bot :4212, errors :4213 (HTTPS :4214). Зупинка — SIGTERM/Ctrl+C. Лише 127.0.0.1.
 */
import { createShopCleanHandler } from "../fixtures/shop-clean/server.js";
import { createShopHandler } from "../fixtures/shop/server.js";
import { startFixtureServer } from "../fixtures/_shared/server.js";
import { startBotFixture } from "../fixtures/bot/server.js";
import { startErrorsFixture } from "../fixtures/errors/server.js";

const shop = await startFixtureServer({ handler: createShopHandler({ mutant: null, control: null, transforms: null }), port: 4210 });
const clean = await startFixtureServer({ handler: createShopCleanHandler({ transforms: null }), port: 4211 });
const bot = await startBotFixture({ port: 4212 });
const errors = await startErrorsFixture({ port: 4213, httpsPort: 4214 });
console.log(JSON.stringify({ shop: shop.origin, clean: clean.origin, bot: bot.origin, errors: errors.origin, errors_https: errors.httpsOrigin }));
const stop = async () => { await Promise.all([shop.close(), clean.close(), bot.close(), errors.close()]); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
