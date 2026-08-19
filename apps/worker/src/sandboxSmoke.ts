import { config } from 'dotenv';
config({ path: new URL('../../../.env.local', import.meta.url) });

import { Sandbox } from '@vercel/sandbox';

async function main() {
    const sandbox = await Sandbox.create();

    const result = await sandbox.runCommand('echo', [
        'Hello from Vercel Sandbox!',
    ]);
    console.log(await result.stdout());
}

main().catch(console.error);
