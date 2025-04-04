import { spawn, SpawnOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Log to stderr to avoid interfering with MCP stdio communication
const logError = (...args: any[]) => console.error('[nghx-error]', ...args);
const logInfo = (...args: any[]) => console.info('[nghx-info]', ...args);

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

// Update prepareRepository to use the correct runners
export async function prepareRepository(owner: string, repo: string, branch: string, cacheDir: string): Promise<string> {
    const safeBranchName = branch.replace(/\//g, '_');
    const repoCachePath = path.join(cacheDir, owner, repo, safeBranchName);
    logInfo(`Target repository cache directory: ${repoCachePath}`);

    const repoExists = await pathExists(repoCachePath);
    const cloneUrl = `https://github.com/${owner}/${repo}.git`;

    if (repoExists) {
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

    if (await pathExists(yarnLockPath)) {
        installCommand = 'yarn';
        installArgs = ['install', '--frozen-lockfile'];
        logInfo('Detected yarn.lock, using yarn.');
    } else if (await pathExists(pnpmLockPath)) {
        installCommand = 'pnpm';
        installArgs = ['install', '--frozen-lockfile'];
        logInfo('Detected pnpm-lock.yaml, using pnpm.');
    } else if (await pathExists(packageLockPath)){
         installCommand = 'npm';
         installArgs = ['ci', '--prefer-offline', '--no-audit', '--progress=false'];
         logInfo('Detected package-lock.json, using npm ci.');
    } else {
         logInfo('No lock file detected, using npm install.');
    }

    if (await needsDependencyInstallation(npxPath, repoDir, runCommandWithOutput)) {
         logInfo(`Running dependency installation (${installCommand} ${installArgs.join(' ')})...`);
        try {
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
    }

    if (runBuild) {
         logInfo('Running build script (npm run build)... ');
         try {
             await runCommand('npm', ['run', 'build'], npxPath);
             logInfo('Build script completed successfully.');
         } catch (buildError) {
             logError(`Build script failed: ${buildError instanceof Error ? buildError.message : buildError}`);
         }
    }

    let commandToRun: string;
    let commandArgs: string[];

    if (args.length === 0) {
        logInfo('No arguments provided, attempting to run main script or default npx command...');
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
            }
        } catch (error) {
            logError(`Error reading or parsing package.json: ${error instanceof Error ? error.message : error}`);
        }

        let scriptToExecute: string | undefined;

        if (packageName && binScript && typeof binScript === 'object' && binScript[packageName]) {
            scriptToExecute = binScript[packageName];
            logInfo(`Found bin script matching package name: ${scriptToExecute}`);
        } else if (binScript && typeof binScript === 'string') {
             scriptToExecute = binScript;
             logInfo(`Found bin script (string): ${scriptToExecute}`);
        } else if (mainScript) {
             scriptToExecute = mainScript;
             logInfo(`Found main script: ${scriptToExecute}`);
        }

        if (scriptToExecute) {
             const scriptPath = path.resolve(npxPath, scriptToExecute);
             const scriptExists = await pathExists(scriptPath);
             logInfo(`Checking existence of script: path='${scriptPath}', exists=${scriptExists}`);

             if (scriptExists) {
                 if (scriptToExecute.endsWith('.js') || scriptToExecute.endsWith('.mjs') || scriptToExecute.endsWith('.cjs')) {
                     logInfo(`Running script with node: ${scriptToExecute}`);
                     commandToRun = 'node';
                     commandArgs = [scriptPath];
                 } else {
                     logInfo(`Script found (${scriptToExecute}), type unclear. Attempting 'npx .'.`);
                     commandToRun = 'npx';
                     commandArgs = ['.'];
                 }
             } else {
                  logInfo(`Script specified (${scriptToExecute}) but not found at ${scriptPath}. Falling back to 'npx .'.`);
                  commandToRun = 'npx';
                  commandArgs = ['.'];
             }
        } else {
             logInfo('No main or bin script found. Falling back to \'npx .\'.');
             commandToRun = 'npx';
             commandArgs = ['.'];
        }

    } else {
        logInfo('Arguments provided, running npx with specified args.');
        commandToRun = 'npx';
        commandArgs = [...args];
    }

    logInfo(`Executing: ${commandToRun} ${commandArgs.join(' ')} in ${npxPath}`);
    try {
        const result = await runCommand(commandToRun, commandArgs, npxPath);
        logInfo('Command completed.');
        return result;
    } catch (error) {
         logError(`Execution failed: ${error instanceof Error ? error.message : error}`);
         if (error instanceof Error) throw error;
         else throw new Error('Execution failed with unknown error');
    }
} 