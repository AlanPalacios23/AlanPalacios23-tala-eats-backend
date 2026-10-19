import { app } from './app.js';
import { config } from './config.js';
import { db } from './db.js';
import { closeQueue } from './queues.js';
const server = app.listen(config.PORT, config.HOST, () => {
  console.log('TALA_NODE_STAGE_API_LISTENING');
});
function shutdown() {
  server.close(() => {
    void Promise.allSettled([closeQueue(), db.$disconnect()]).then(() => process.exit(0));
  });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
