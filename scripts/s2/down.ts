/** Зупиняє стек S2 за PID-файлами (після аварійно перерваного сценарію). Лише записані pid; pgrep/pkill за шаблоном не використовується. */
import { dbDown, stopGraceful } from "./stack.js";
for (const n of ["worker", "api", "fixtures"] as const) await stopGraceful(n);
dbDown();
console.log("s2 stack stopped");
