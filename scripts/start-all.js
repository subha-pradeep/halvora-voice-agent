// Runs the web server and (if configured) the LiveKit worker in one service, e.g. one Render instance.
// The worker is restarted if it crashes; the web server exiting stops everything.
import 'dotenv/config';
import { spawn } from 'node:child_process';

const server = spawn(process.execPath, ['server/index.js'], { stdio: 'inherit' });
let worker = null;
let stopping = false;
function startWorker(delay = 0) {
  if (!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET)) return;
  setTimeout(() => {
    if (stopping) return;
    worker = spawn(process.execPath, ['livekit-agent/agent.js', 'start'], { stdio: 'inherit' });
    worker.on('exit', (code) => { if (!stopping) { console.error(`[start-all] LiveKit worker exited (${code}); restarting in 5s`); startWorker(5000); } });
  }, delay);
}
startWorker(1500); // give the web server a moment to bind (the worker calls it for tools/metrics)
const stop = () => { stopping = true; worker?.kill('SIGTERM'); server.kill('SIGTERM'); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
server.on('exit', (code) => { stopping = true; worker?.kill('SIGTERM'); process.exit(code ?? 1); });
