import { config } from 'dotenv';
config({ path: '.env.local' });

import { Sandbox } from '@vercel/sandbox';

async function main() {
    const sandbox = await Sandbox.create();

    const result = await sandbox.runCommand('echo', [
        'Hello from Vercel Sandbox!',
    ]);
    console.log(await result.stdout());
}

main().catch(console.error);
