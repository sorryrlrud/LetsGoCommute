# Agent Instructions

## Completion Workflow

- After any code modification, run the relevant local verification before finishing. At minimum, use `npm run lint` and `npm run build` when frontend code, config, storage, types, or PWA behavior changes.
- When verification passes, commit the completed changes and push the current branch to `origin`.
- After pushing changes that affect the app, wait for the GitHub Pages deployment workflow (`deploy-pages.yml`) to complete.
- Confirm the deployed Pages site is available at `https://sorryrlrud.github.io/LetsGoCommute/` and that the latest deployment SHA matches the pushed commit.
- Report the commit hash, verification results, and Pages deployment status in the final response.
