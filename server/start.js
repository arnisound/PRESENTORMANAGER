// Lancement en mode serveur (en ligne ou réseau local) : node server/start.js
import { startServer, lanAddresses } from './index.js';

const port = Number(process.env.PORT || 4517);
const srv = await startServer({ port, dataDir: process.env.DATA_DIR || undefined });
console.log(`\n  Presentor Manager prêt`);
console.log(`  Régie        : ${srv.url}/control/`);
for (const ip of lanAddresses()) console.log(`  Réseau local : http://${ip}:${srv.port}/`);
console.log(`  Vote public  : ${srv.url}/vote/`);
if (!process.env.PRESENTOR_PIN) console.log('  (astuce : définissez PRESENTOR_PIN pour protéger la régie en ligne)');
const stop = async () => { await srv.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
