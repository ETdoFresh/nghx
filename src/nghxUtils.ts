import { spawn, SpawnOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Log to stderr to avoid interfering with MCP stdio communication
const logError = (...args: any[]) => console.error('[nghx-error]', ...args);
const logInfo = (...args: any[]) => console.log('[nghx-info]', ...args);

// Helper to run commands asynchronously and wait for completion
function runCommand(command: string, args: string[], cwd: string): Promise<{ code: number | null }> {
    return new Promise((resolve, reject) => {
        logInfo(`Running command: ${command} ${args.join(' ')} in ${cwd}`);
        const options: SpawnOptions = { cwd, shell: true, stdio: 'inherit' };
        const process = spawn(command, args, options);

        process.on('close', (code) => {
            logInfo(`Command finished with code ${code}`);
            resolve({ code });
        });

        process.on('error', (err) => {
            logError('Spawn error:', err);
            reject(err);
        });
    });
}

export function parseGitHubUrl(url: string): { owner: string; repo: string; branch: string; subPath: string } {
    logInfo(`Parsing GitHub URL: ${url}`);
    const githubRegex = /^https:\/\/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?(?:\/tree\/([^\/]+)(?:\/(.+))?)?$/;
    const match = url.match(githubRegex);

    if (!match) {
        throw new Error(`Invalid GitHub URL format: ${url}`);
    }

    const owner = match[1];
    const repo = match[2];
    const branch = match[3] || 'main'; // Default to main if no branch specified
    const subPath = match[4]?.replace(/\/$/, '') || ''; // Remove trailing slash if present

    logInfo(`Parsed URL components -> Owner: ${owner}, Repo: ${repo}, Branch: ${branch}, SubPath: ${subPath || '(root)'}`);
    return { owner, repo, branch, subPath };
}

export function getCacheDir(): string {
    let cacheDir: string;
    // Consistent cache directory naming
    const cacheDirName = '_nghx_cache';
    if (process.platform === 'win32') {
      // Use LOCALAPPDATA if available, otherwise fall back to AppData/Roaming
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData) {
        cacheDir = path.join(localAppData, cacheDirName);
      } else {
        cacheDir = path.join(os.homedir(), 'AppData', 'Roaming', cacheDirName);
      }
    } else if (process.platform === 'darwin') {
      // macOS: ~/Library/Caches/
      cacheDir = path.join(os.homedir(), 'Library', 'Caches', cacheDirName);
    } else {
      // Linux/other Unix: Use XDG_CACHE_HOME or default to ~/.cache
      const xdgCacheHome = process.env.XDG_CACHE_HOME;
      cacheDir = xdgCacheHome
        ? path.join(xdgCacheHome, cacheDirName)
        : path.join(os.homedir(), '.cache', cacheDirName);
    }

    logInfo(`Using cache directory: ${cacheDir}`);
    return cacheDir;
}

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function wasRecentlyPulled(repoCachePath: string): Promise<boolean> {
    const lastPullFile = path.join(repoCachePath, '.nghx-last-pull');
    if (!(await pathExists(lastPullFile))) {
        return false;
    }
    try {
        const lastPullTime = parseInt(await fs.readFile(lastPullFile, 'utf8'), 10);
        const currentTime = Date.now();
        const elapsedTimeMin = (currentTime - lastPullTime) / (1000 * 60);
        logInfo(`Last pull was ${elapsedTimeMin.toFixed(2)} minutes ago`);
        return elapsedTimeMin < 1; // Cache for 1 minute
    } catch (error) {
        logError(`Error checking last pull time: ${error instanceof Error ? error.message : error}`);
        return false;
    }
}

async function updateLastPullTime(repoCachePath: string): Promise<void> {
    const lastPullFile = path.join(repoCachePath, '.nghx-last-pull');
    try {
        await fs.writeFile(lastPullFile, Date.now().toString(), 'utf8');
        logInfo(`Updated last pull time in ${lastPullFile}`);
    } catch (error) {
        logError(`Error updating last pull time: ${error instanceof Error ? error.message : error}`);
    }
}

// Helper function specifically for running commands where output capture is needed (like git rev-parse)
async function runCommandWithOutput(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
        logInfo(`Running command (capture output): ${command} ${args.join(' ')} in ${cwd}`);
        const process = spawn(command, args, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';

        process.stdout?.on('data', (data) => { stdout += data.toString(); });
        process.stderr?.on('data', (data) => { stderr += data.toString(); });

        process.on('close', (code) => {
            logInfo(`Command (capture output) finished with code ${code}`);
            if (code === 0 || code === null) {
                resolve({ stdout, stderr, code });
            } else {
                reject(new Error(`Command failed with code ${code}: ${stderr || stdout || 'Unknown error'}`));
            }
        });

        process.on('error', (err) => {
            logError('Spawn error (capture output):', err);
            reject(err);
        });
    });
}

// Update functions that need output capture to accept the command runner
async function getCurrentCommitSha(repoDir: string, commandRunner: typeof runCommandWithOutput): Promise<string | null> {
    try {
        const { stdout } = await commandRunner('git', ['rev-parse', 'HEAD'], repoDir);
        return stdout.trim();
    } catch (error) {
        logError(`Error getting current commit SHA: ${error instanceof Error ? error.message : error}`);
        return null;
    }
}

async function needsDependencyInstallation(npxPath: string, repoDir: string, commandRunner: typeof runCommandWithOutput): Promise<boolean> {
    const lastUpdateFile = path.join(npxPath, '.nghx-last-install-sha');
    if (!(await pathExists(lastUpdateFile))) {
        logInfo(`No last install SHA found in ${npxPath}, dependencies need installation.`);
        return true;
    }
    try {
        const lastCommitSha = await fs.readFile(lastUpdateFile, 'utf8');
        const currentCommitSha = await getCurrentCommitSha(repoDir, commandRunner);

        if (!currentCommitSha) {
             logInfo(`Could not get current commit SHA for ${repoDir}, assuming dependencies need installation.`);
            return true; // If we can't get the current SHA, assume install needed
        }

        const needsInstall = lastCommitSha.trim() !== currentCommitSha.trim();
        logInfo(`Last install SHA: ${lastCommitSha.trim()}, Current SHA: ${currentCommitSha.trim()}. Needs install: ${needsInstall}`);
        return needsInstall;
    } catch (error) {
        logError(`Error checking dependency status: ${error instanceof Error ? error.message : error}`);
        return true; // Assume install needed on error
    }
}

async function updateLastDependencyInstallSha(npxPath: string, repoDir: string, commandRunner: typeof runCommandWithOutput): Promise<void> {
    const lastUpdateFile = path.join(npxPath, '.nghx-last-install-sha');
    try {
        const currentCommitSha = await getCurrentCommitSha(repoDir, commandRunner);
        if (currentCommitSha) {
            await fs.writeFile(lastUpdateFile, currentCommitSha, 'utf8');
            logInfo(`Updated last install SHA in ${lastUpdateFile} to ${currentCommitSha}`);
        } else {
             logError(`Could not get current commit SHA for ${repoDir} to update last install SHA.`);
        }
    } catch (error) {
        logError(`Error updating last install SHA: ${error instanceof Error ? error.message : error}`);
    }
}

// Update prepareRepository to use the correct runners and accept the noUpdate flag
export async function prepareRepository(
    owner: string,
    repo: string,
    branch: string,
    cacheDir: string,
    noUpdate: boolean // Add the noUpdate flag
): Promise<string> {
    const safeBranchName = branch.replace(/\//g, '_');
    const repoCachePath = path.join(cacheDir, owner, repo, safeBranchName);
    logInfo(`Target repository cache directory: ${repoCachePath}`);

    const repoExists = await pathExists(repoCachePath);
    const cloneUrl = `https://github.com/${owner}/${repo}.git`;

    if (repoExists) {
        // Check for the --no-update flag first
        if (noUpdate) {
            logInfo('Repository exists in cache and --no-update flag specified. Skipping update.');
            return repoCachePath;
        }

        logInfo('Repository exists in cache. Checking for updates...');
        if (await wasRecentlyPulled(repoCachePath)) {
            logInfo('Repository recently pulled. Skipping update.');
            return repoCachePath;
        }
        try {
            await runCommand('git', ['fetch', '--depth=1', 'origin', branch], repoCachePath);
            const { stdout: fetchedCommit } = await runCommandWithOutput('git', ['rev-parse', `origin/${branch}`], repoCachePath);
            await runCommand('git', ['reset', '--hard', fetchedCommit.trim()], repoCachePath);
            logInfo(`Repository updated to origin/${branch}`);
            await updateLastPullTime(repoCachePath);
        } catch (error) {
             logError(`Failed to update repository: ${error instanceof Error ? error.message : error}. Proceeding with cached version.`);
             // Even if update fails, return the existing path
             return repoCachePath;
        }
    } else {
        logInfo(`Cloning repository ${cloneUrl} (branch: ${branch})...`);
        try {
            await fs.mkdir(path.dirname(repoCachePath), { recursive: true });
            await runCommand('git', ['clone', '--branch', branch, '--depth=1', cloneUrl, repoCachePath], cacheDir);
            logInfo('Repository cloned successfully.');
            await updateLastPullTime(repoCachePath);
        } catch (error) {
            logError(`Failed to clone repository: ${error instanceof Error ? error.message : error}`);
            try {
                if (await pathExists(repoCachePath)) {
                    await fs.rm(repoCachePath, { recursive: true, force: true });
                }
            } catch (rmError) {
                logError(`Failed to clean up directory after clone error: ${rmError}`);
            }
            throw new Error(`Failed to clone repository ${cloneUrl} branch ${branch}`);
        }
    }
    return repoCachePath;
}

// Update runNpx to use correct runners and return only the code
export async function runNpx(
    npxPath: string,
    args: string[],
    repoDir: string // Pass repoDir for SHA checking
): Promise<{ code: number | null }> {
    logInfo(`Running npx in directory: ${npxPath}`);
    logInfo(`Additional arguments: ${args.length > 0 ? args.join(' ') : '(none)'}`);

    if (!(await pathExists(npxPath))) {
        throw new Error(`Target path for npx does not exist: ${npxPath}`);
    }

    let installCommand = 'npm';
    let installArgs = ['install', '--prefer-offline', '--no-audit', '--progress=false'];
    const packageLockPath = path.join(npxPath, 'package-lock.json');
    const yarnLockPath = path.join(npxPath, 'yarn.lock');
    const pnpmLockPath = path.join(npxPath, 'pnpm-lock.yaml');

    if (await pathExists(pnpmLockPath)) {
        logInfo('Found pnpm-lock.yaml, using pnpm for installation.');
        installCommand = 'pnpm';
        installArgs = ['install', '--prefer-offline', '--no-frozen-lockfile']; // pnpm might use different flags
    } else if (await pathExists(yarnLockPath)) {
        logInfo('Found yarn.lock, using yarn for installation.');
        installCommand = 'yarn';
        installArgs = ['install', '--prefer-offline']; // yarn uses different flags
    } else if (await pathExists(packageLockPath)) {
        logInfo('Found package-lock.json, using npm ci for installation.');
        installCommand = 'npm';
        installArgs = ['ci', '--prefer-offline', '--no-audit', '--progress=false'];
    } else {
        logInfo('No lockfile found, using npm install.');
        // Keep default npm install args
    }

    // INSTALL DEPENDENCIES (if needed)
    if (await needsDependencyInstallation(npxPath, repoDir, runCommandWithOutput)) {
         logInfo(`Running dependency installation (${installCommand} ${installArgs.join(' ')})...`);
        try {
            // Use runCommand for installation steps that don't need output capture
            await runCommand(installCommand, installArgs, npxPath);
            logInfo('Dependencies installed successfully.');
            await updateLastDependencyInstallSha(npxPath, repoDir, runCommandWithOutput);
        } catch (error) {
            logError(`Dependency installation failed: ${error instanceof Error ? error.message : error}`);
            throw new Error(`Dependency installation failed in ${npxPath}.`);
        }
    } else {
         logInfo('Dependencies appear up-to-date based on commit SHA. Skipping installation.');
    }

    // RUN BUILD SCRIPT (if applicable)
    const packageJsonPathBuildCheck = path.join(npxPath, 'package.json');
    let runBuild = false;
    try {
        if (await pathExists(packageJsonPathBuildCheck)) {
            const pkgContent = await fs.readFile(packageJsonPathBuildCheck, 'utf8');
            const pkg = JSON.parse(pkgContent);
            if (pkg.scripts && pkg.scripts.build) {
                logInfo('Found build script in package.json.');
                runBuild = true;
            } else {
                logInfo('No build script found in package.json.');
            }
        }
    } catch(error) {
         logError(`Error checking for build script: ${error instanceof Error ? error.message : error}`);
         // Decide whether to halt or proceed without building
    }

    if (runBuild) {
         logInfo('Running build script (npm run build)...');
         try {
             await runCommand('npm', ['run', 'build'], npxPath);
             logInfo('Build script completed successfully.');
         } catch (buildError) {
             logError(`Build script failed: ${buildError instanceof Error ? buildError.message : buildError}`);
             // If build fails, execution likely won't work, so throw an error.
             throw new Error(`Build script failed in ${npxPath}.`);
         }
    }

    // DETERMINE HOW TO EXECUTE
    let commandToRun: string;
    let commandArgs: string[];

    if (args.length === 0) {
        // No arguments passed to nghx itself (beyond the repo URL)
        logInfo('No specific npx arguments provided, attempting to determine default execution...');
        const packageJsonPath = path.join(npxPath, 'package.json');
        let mainScript: string | undefined;
        let binScript: string | Record<string, string> | undefined;
        let packageName: string | undefined;
        try {
            if (await pathExists(packageJsonPath)) {
                const packageJsonContent = await fs.readFile(packageJsonPath, 'utf8');
                const packageJson = JSON.parse(packageJsonContent);
                mainScript = packageJson.main;
                binScript = packageJson.bin;
                packageName = packageJson.name;
                logInfo(`package.json found: main='${mainScript}', bin='${JSON.stringify(binScript)}', name='${packageName}'`);
            } else {
                 logInfo('package.json not found in execution directory.');
            }
        } catch (error) {
            logError(`Error reading or parsing package.json: ${error instanceof Error ? error.message : error}`);
            // Continue and fallback to 'npx .'
        }

        let scriptToExecute: string | undefined;

        // Prioritize bin script matching package name
        if (packageName && binScript && typeof binScript === 'object' && binScript[packageName]) {
            scriptToExecute = binScript[packageName];
            logInfo(`Using bin script matching package name: ${scriptToExecute}`);
        } else if (binScript && typeof binScript === 'string') {
             // Use string bin script if available
             scriptToExecute = binScript;
             logInfo(`Using string bin script: ${scriptToExecute}`);
        } else if (mainScript) {
             // Fallback to main script
             scriptToExecute = mainScript;
             logInfo(`Using main script: ${scriptToExecute}`);
        }

        if (scriptToExecute) {
             const scriptFullPath = path.resolve(npxPath, scriptToExecute);
             const scriptExists = await pathExists(scriptFullPath);
             logInfo(`Resolved script path: '${scriptFullPath}', Exists: ${scriptExists}`);

             if (scriptExists) {
                 // Basic check if it looks runnable by node
                 if (scriptToExecute.endsWith('.js') || scriptToExecute.endsWith('.mjs') || scriptToExecute.endsWith('.cjs')) {
                     logInfo(`Executing main/bin script directly with node.`);
                     commandToRun = 'node';
                     commandArgs = [scriptFullPath]; // Pass the resolved path
                 } else {
                     // If not obviously a JS file, assume it's an executable script or rely on npx's bin handling
                     logInfo(`Script type unclear or not a .js file. Using 'npx .' to execute the package's defined binary.`);
                     commandToRun = 'npx';
                     // npx . should correctly pick up the bin script defined in package.json
                     commandArgs = ['.'];
                 }
             } else {
                  logInfo(`Specified script '${scriptToExecute}' not found at '${scriptFullPath}'. Falling back to 'npx .'.`);
                  commandToRun = 'npx';
                  commandArgs = ['.'];
             }
        } else {
             // Ultimate fallback if no specific script could be determined
             logInfo(`No main or bin script could be determined. Falling back to 'npx .' which might execute the default binary.`);
             commandToRun = 'npx';
             commandArgs = ['.'];
        }

    } else {
        // Arguments were passed to nghx
        logInfo(`NPX arguments provided ('${args.join(' ')}'). Executing package via 'npx .' with these arguments.`);
        commandToRun = 'npx';
        // Prepend '.' to target the local directory, followed by user args
        commandArgs = ['.', ...args];
    }

    // EXECUTE THE COMMAND
    logInfo(`Final execution command: ${commandToRun} ${commandArgs.join(' ')} in ${npxPath}`);
    try {
        // Use runCommand which inherits stdio and returns the exit code
        const result = await runCommand(commandToRun, commandArgs, npxPath);
        logInfo(`Execution finished with code ${result.code}.`);
        return result; // Return the { code } object
    } catch (error) {
         logError(`Execution failed: ${error instanceof Error ? error.message : error}`);
         // Re-throw the error to be caught by the main function
         if (error instanceof Error) throw error;
         else throw new Error('Execution failed with an unknown error.');
    }
} 