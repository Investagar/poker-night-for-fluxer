import { setTimeout as sleep } from 'node:timers/promises';
import { buildApp } from './app.ts';
import { type Config, ConfigError, loadConfig } from './config.ts';
import { openDatabase } from './db.ts';

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`Invalid configuration: ${error.message}`);
  process.exit(1);
}

const db = openDatabase(config.databasePath);
const { app, fluxer, bot } = await buildApp({ config, db });

let stopping = false;
async function discover(): Promise<void> {
  for (let delay = 1000; !stopping; delay = Math.min(60_000, delay * 2)) {
    try {
      await fluxer.discover();
      app.log.info('Fluxer discovery complete; bot account verified');
      if (!stopping) bot.start();
      return;
    } catch (error) {
      app.log.warn(`Fluxer discovery failed: ${error instanceof Error ? error.message : 'unknown error'}; retrying in ${delay / 1000}s`);
      await sleep(delay, undefined, { ref: false });
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopping = true;
    void app.close().then(() => db.close()).catch((error: unknown) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}

await app.listen({ host: config.host, port: config.port });
void discover();
