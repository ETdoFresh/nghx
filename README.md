# nghx - Run NPX on GitHub Repositories (including subpaths)

`nghx` is a command-line tool that clones (or updates) a specified GitHub repository (or a subpath within it) to a local cache and then executes `npx` within that directory. This allows you to run packages directly from GitHub that might not be published to npm or require a specific setup available only in the repository context.

## Installation

To install `nghx` globally, you can clone the repository and install from the local directory:

```bash
# Install from a local clone
git clone https://github.com/ETdoFresh/nghx.git
cd nghx
npm install -g .
```

Alternatively, once published, you can install from npm:

```bash
# Install from npm (if published)
npm install -g nghx
```

## Usage

### Method 1: Using the Globally Installed Command

Once installed globally, use the `nghx` command directly:

```bash
nghx <github_url> [npx_args...]
```

**Example:**

```bash
# Run the default npx command in the root of the create-react-app repo
nghx https://github.com/facebook/create-react-app

# Run 'npx eslint --fix' within the 'packages/react-scripts' subpath of create-react-app
nghx https://github.com/facebook/create-react-app/tree/main/packages/react-scripts eslint --fix
```

### Method 2: Running via Local Clone (without global install)

Clone this repository and run `npx` from within its directory, passing the target GitHub URL and any additional arguments you want to pass to the final `npx` command:

```bash
git clone https://github.com/ETdoFresh/nghx.git
cd nghx
npx . <github_url> [npx_args...]
```

**Example:**

```bash
npx . https://github.com/facebook/create-react-app
```

## Note on `npx github:ETdoFresh/nghx`

While `npx` typically supports running packages directly using the `npx github:user/repo` syntax, there seem to be environment-specific issues (observed on Windows/PowerShell) that prevent this method from working correctly with `nghx`. It often results in a `'nghx' is not recognized...` error, likely due to problems with how `npx` makes the command temporarily available.

Therefore, installing globally or using the local clone method (`npx . <url>`) is recommended for reliable execution.

## How it Works

1.  **Parse URL:** Extracts owner, repo, branch, and subpath from the GitHub URL.
2.  **Prepare Repo:** Clones the repository to a central cache (`~/.nghx_cache` or platform equivalent) if not present, or pulls the latest changes if it exists. Handles checking out the correct branch/commit.
3.  **Check Subpath:** Navigates to the specified subpath within the cloned repository.
4.  **Install Deps:** Runs `npm ci` (or `npm install`) if necessary (e.g., first run, or if `package-lock.json` changed).
5.  **Build:** Runs `npm run build` if a build script exists in `package.json`.
6.  **Execute:** Runs `npx` within the target directory, passing any additional arguments provided. If no specific package is provided in the arguments, it attempts to run the default package defined in the target repository's `package.json`. 