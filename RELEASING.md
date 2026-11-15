# Releasing

`.github/workflows/release.yml` releases all three SDKs with one version number. It runs every hour and on a pushed `v*` tag.

## How a release happens

1. The workflow reads `https://app.frontmost.ai/api/v1/openapi.json`.
2. If the live spec equals `spec/openapi.json`, it stops.
3. If the change is a break, it opens an issue named "The live API has a breaking change" and stops.
4. Otherwise it regenerates the SDKs, runs the conformance cases and the README check, and bumps the version.
5. It pushes the commit and a `vX.Y.Z` tag to `main`.
6. It publishes to npm, PyPI, and crates.io, then creates the GitHub release.

Each publish job skips a version that is already on its registry. A failed job can run again safely.

## Release by hand

Do this for a break that Ian signed off, or for a change to a hand-written `core` file.

1. Run `node scripts/bump.mjs major` for a break. Before 1.0.0, it bumps the minor number (0.1.x to 0.2.0).
2. Commit the change to `main`.
3. Run `git tag vX.Y.Z` with the version that the script printed.
4. Run `git push origin main vX.Y.Z`.

The tag starts the publish jobs.

## One-time setup

Ian must do these steps once, because each one needs his sign-in. The workflow cannot publish until all of them are done.

### GitHub

1. Open the repository's **Settings > Environments**.
2. Make sure an environment named `release` exists.

### npm

npm trusts a workflow only for a package that already exists. So the first version goes up by hand.

1. Sign in at [npmjs.com](https://www.npmjs.com). Create the organization `frontmost-ai`.
2. Run `npm login` on your computer.
3. Run `cd typescript && npm ci && npm run build && npm publish --provenance=false`.
4. On npmjs.com, open **@frontmost-ai/sdk > Settings > Trusted Publisher**.
5. Choose GitHub Actions. Enter organization `frontmost-ai`, repository `sdks`, workflow `release.yml`, and environment `release`.

### PyPI

PyPI trusts a workflow before the project exists.

1. Sign in at [pypi.org](https://pypi.org).
2. Open **Your projects > Publishing > Add a new pending publisher**.
3. Enter project `frontmost`, owner `frontmost-ai`, repository `sdks`, workflow `release.yml`, and environment `release`.

### crates.io

crates.io trusts a workflow only for a crate that already exists. So the first version goes up by hand.

1. Sign in at [crates.io](https://crates.io) with GitHub.
2. Create an API token in **Account Settings > API Tokens**, then run `cargo login`.
3. Run `cd rust && cargo publish`.
4. Open **frontmost-ai > Settings > Trusted Publishing**.
5. Add repository owner `frontmost-ai`, repository `sdks`, workflow `release.yml`, and environment `release`.

### After the setup

Version 0.1.0 is already a GitHub release with the three packages attached. Its Release run was cancelled, because no registry trusted the workflow yet.

1. Open **Actions > Release** in GitHub.
2. Open the run for tag `v0.1.0`.
3. Click **Re-run all jobs**.

The npm and crates.io jobs skip 0.1.0, because you published it by hand. The PyPI job publishes it. The next API change publishes all three SDKs.

Then change the install commands in `README.md`, each language README, and the Frontmost AI API docs to the registry commands.

## Keep the hourly run alive

GitHub turns off a scheduled workflow after 60 days with no commit to the repository. Each release adds a commit. If GitHub turns it off, open **Actions > Release** and turn it on again.
