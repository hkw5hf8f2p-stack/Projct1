/** pnpm db:start | db:stop | db:status | db:migrate (Node ≥ 22, tsx). */
import { DbDaemon } from "./embedded.js";
import { dbConfigFromEnv, loadDotEnv } from "./env.js";
import { migrate } from "./migrate.js";

loadDotEnv();
const cfg = dbConfigFromEnv();
const daemon = new DbDaemon({ dataDir: cfg.dataDir, port: cfg.port, pidFile: cfg.pidFile, logFile: cfg.logFile });
const cmd = process.argv[2];
try {
  if (cmd === "start") console.log(JSON.stringify(await daemon.start()));
  else if (cmd === "stop") console.log(JSON.stringify(await daemon.stop()));
  else if (cmd === "status") console.log(JSON.stringify({ ...daemon.status(), pid_file_matches: daemon.pidFileMatches() }));
  else if (cmd === "migrate") {
    const r = await migrate(cfg.databaseUrl);
    console.log(JSON.stringify(r));
  } else {
    console.error("usage: db <start|stop|status|migrate>");
    process.exit(2);
  }
} catch (e) {
  console.error(`db ${cmd}: ${(e as Error).message}`);
  process.exit(1);
}
