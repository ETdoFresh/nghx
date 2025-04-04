#!/usr/bin/env node

// Standard Node.js modules
import path from 'node:path';
import fs from 'node:fs/promises';

// Our utility functions
import { parseGitHubUrl, getCacheDir, prepareRepository, runNpx } from './nghxUtils.js';

// Simple logger to stderr
const logError = (...args: any[]) => console.error('[nghx-error]', ...args);
const logInfo = (...args: any[]) => console.error('[nghx-info]', ...args);

// Main CLI function
async function main() {
    // Basic argument parsing (adjust as needed for more complex flags)
    // process.argv contains: [node executable, script path, arg1, arg2, ...]
    const args = process.argv.slice(2);
    if (args.length < 1) {
        logError('Usage: nghx <github_url> [npx_args...]');
        process.exit(1);
    }

    const github_url = args[0];
    const npxArgs = args.slice(1);

    logInfo(`Received URL: ${github_url}`);
    logInfo(`Received NPX Args: ${npxArgs.join(' ')}`);
    logInfo("Process: Parse URL -> Prepare Repo (clone/update) -> Build (if needed) -> Execute (node main/npx args)");

    try {
        // 1. Parse URL
        const { owner, repo, branch, subPath } = parseGitHubUrl(github_url);

        // 2. Get/Prepare Cache
        const cacheDir = getCacheDir();
        // Ensure cache dir exists
        await fs.mkdir(cacheDir, { recursive: true }); 
        const repoDir = await prepareRepository(owner, repo, branch, cacheDir);

        // 3. Determine execution path (repo root or subpath)
        const executionPath = subPath ? path.join(repoDir, subPath) : repoDir;
        logInfo(`Final execution path: ${executionPath}`);

        // 4. Run NPX (includes install/build logic)
        const { stdout, stderr, code } = await runNpx(executionPath, npxArgs, repoDir);

        // 5. Output results to console
        if (stdout) {
            console.log(stdout); // Output stdout to console
        }
        if (stderr) {
            console.error(stderr); // Output stderr to console's stderr
        }

        // Exit with the same code as the executed process
        process.exit(code ?? 1); 

    } catch (error: any) {
        logError(`Operation failed: ${error.message}`);
        if (error.stack) {
             console.error(error.stack); // Log stack to stderr for debugging
        }
        process.exit(1);
    }
}

// Run the main function
main().catch((error) => {
    // Catch any unhandled promise rejections from main()
    logError("Unhandled error during execution:", error);
    process.exit(1);
}); 