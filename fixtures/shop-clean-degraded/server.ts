/**
 * Копія `fixtures/shop-clean` із п'ятьма навмисними погіршеннями SPEC §67 (DEV-16, DEV-74) для E3c.
 * Це НЕ окрема кодова база: `createShopCleanHandler({ degrade })` — ті самі шаблони, тому «та сама копія + 5 змін» доведено
 * побудовою. Сліпий прогін: сервер не містить слова «degraded» ні в URL, ні в тілі, ні в заголовках (перевіряє degraded.test.ts);
 * аудитор бачить лише нейтральний хост (`site-a.test` / `site-b.test`, див. scripts/validate/snapshots.ts).
 *
 * Зміни (кожна — видалення/ослаблення того, що в `shop-clean` Є):
 *   shipping   — нема блоку доставки на сторінці товару, нема сторінки й посилань «Доставка й оплата» (/shipping → 404)
 *              (у футері місце посилань займають нейтральні «Каталог»/«Головна» — щоб сторінка не стала «thin» для класифікатора, DEV-34)
 *   cta        — кнопка купівлі після 1650-пікселного опису → нижче першого вікна (D і M)
 *   headline   — H1 головної «Каталог товарів для дому» → «Якість, що надихає» (без назви категорії)
 *   comparison — у каталозі зникли ціни на картках: порівняти товари можна лише відкриваючи кожен
 *   trust      — нема сторінки й посилань «Про нас», з опису прибрано речення про гарантійний талон
 * Побічно (спостережено на прогоні validate 30.09.2026): зміна `comparison` (картка без ціни) робить alt зображення дублікатом
 * тексту посилання → axe `image-redundant-alt` на /catalog (категорія `accessibility`, ПОЗА вимірами E3c → лише в
 * інформативному |ΔD|). Детектор ціни на category при цьому НЕ спрацював.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer, type FixtureServer, type SiteHandler } from "../_shared/server.js";
import { createShopCleanHandler, DEGRADATIONS, type ShopCleanOptions } from "../shop-clean/server.js";

export { DEGRADATIONS };
export type { Degradation } from "../shop-clean/server.js";

export function createShopCleanDegradedHandler(opts: Omit<ShopCleanOptions, "degrade"> = {}): SiteHandler {
  return createShopCleanHandler({ ...opts, degrade: DEGRADATIONS });
}

export async function startShopCleanDegraded(opts: Omit<ShopCleanOptions, "degrade"> = {}): Promise<FixtureServer> {
  return startFixtureServer({ handler: createShopCleanDegradedHandler(opts), logFile: opts.logFile, port: opts.port });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startShopCleanDegraded({ logFile: process.env.FIXTURE_LOG, port: process.env.PORT ? Number(process.env.PORT) : 4213 });
  console.log(`fixture on ${s.origin}`);
}
