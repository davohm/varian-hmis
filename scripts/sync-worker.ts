import { runSyncCycle, startSyncWorker } from "../src/server/sync/worker";

async function main() {
  if (process.argv.includes("--once")) {
    const result = await runSyncCycle({}, { push: true, pull: true });
    console.log(JSON.stringify(result, null, 2));
    if (result.errors.length > 0) process.exitCode = 1;
    return;
  }
  await startSyncWorker();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
