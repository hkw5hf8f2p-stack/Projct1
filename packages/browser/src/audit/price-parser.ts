/** Узагальнений парсер цін: той самий код виконується в сторінці й у Node (page-scripts/price.js). */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ParsedPrice { value: number; currency: "UAH" | "EUR" | "USD" | "GBP" | "PLN"; text: string; index: number; prefix_from: boolean }

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** вихідний текст виразу-IIFE (для ін'єкції в page.evaluate) */
export const PRICE_PARSER_SOURCE = readFileSync(path.join(HERE, "page-scripts", "price.js"), "utf8").trim();
const fn = new Function(`return (\n${PRICE_PARSER_SOURCE}\n)`)() as (t: string) => ParsedPrice[];

export const parsePrices = (text: string): ParsedPrice[] => fn(text);
export const parsePrice = (text: string): ParsedPrice | null => parsePrices(text)[0] ?? null;
