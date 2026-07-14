import { checkForProjectUpdate } from './check.js';
import { formatUpdateStatus } from './format.js';

const status = await checkForProjectUpdate({ force: true });
process.stdout.write(`${formatUpdateStatus(status)}\n`);
if (status.kind === 'unavailable') process.exitCode = 2;
