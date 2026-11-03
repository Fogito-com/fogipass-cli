# Publishing FogiPass CLI to npm

Package: `fogipass-cli`; executable: `fogipass`. The first public release,
`0.2.0`, was published on 3 November 2026 (UTC). Verify current versions and
ownership in the registry before each release.
No npm credential belongs in this repository or its GitHub Actions secrets.

## Updating the package and npm page

npm renders the README bundled with the published package. It does not sync
README edits from GitHub. Branding/documentation changes therefore need a new
patch version even when command behavior is unchanged.

1. Update `README.md`. Keep image URLs absolute so they render on both GitHub
   and npm. Pin the logo URL to the reviewed Git commit containing the asset to
   avoid branch-cache delays. The logo is in `assets/fogipass-logo.png` on GitHub
   and is intentionally excluded from the runtime package allowlist.
2. Bump the version in `package.json`, `lib/client.js` and `package-lock.json`.
3. Test and scan the exact package on `alpha`, push it and wait for CI to pass.
   Promote the reviewed commit to `master` and verify its CI too.
4. Publish through the trusted workflow below if the owner has configured it.
   Otherwise use the owner's existing interactive npm login, then run
   `npm publish --access public` from the clean reviewed `master` checkout.
   Complete npm's browser/2FA approval yourself; never share credentials in chat.
5. Verify `npm view fogipass-cli version repository dist.integrity`, the README
   returned by `npm view fogipass-cli readme`, and the package page. Run the exact
   new version with `npx fogipass-cli@VERSION --version` without logging in.

Source: [npm README updates](https://docs.npmjs.com/about-package-readme-files/).

## First-publication reference (completed for 0.2.0)

1. Sign in or create the npm account that should own this unscoped package.
   Verify its email and enable two-factor authentication. Keep recovery codes
   privately; do not share passwords, tokens or authentication codes in a chat.
2. Use Node.js 24 LTS and npm 11.5.1 or newer. In a clean checkout of this
   repository, switch to `master` and pull the latest version. Check that its
   **CLI tests** workflow has passed on the exact commit being published.
3. Review package ownership and licensing. `license: UNLICENSED` preserves the
   current absence of an open-source license; no permission to relicense was
   assumed. Choose a license separately if broader reuse rights are intended.
4. Run:

   ```sh
   npm ci --ignore-scripts
   npm test
   npm run check:package
   npm run test:package
   npm audit --omit=dev
   npm login --auth-type=web --registry=https://registry.npmjs.org/
   npm whoami --registry=https://registry.npmjs.org/
   npm view fogipass-cli name version repository --registry=https://registry.npmjs.org/
   ```

5. On the first release, the final lookup should return E404. If the name now
   belongs to someone else, stop: do not install or overwrite it. Agree a scoped
   name and update the manifest, tests, lockfile and instructions first.
6. Publish the reviewed `master` checkout, completing npm's browser/2FA prompt:

   ```sh
   npm publish --access public
   ```

7. Verify the new package and execution:

   ```sh
   npm view fogipass-cli@0.2.0 version repository dist.integrity
   npx fogipass-cli@0.2.0 --version
   npx fogipass-cli@0.2.0 login --name "My workstation"
   npx fogipass-cli@0.2.0 status
   npx fogipass-cli@0.2.0 logout
   ```

The first local publication is interactive, not OIDC, and has no GitHub provenance
attestation. Subsequent GitHub publications use the workflow below. npm package
versions are immutable; a later release must have a new version.

Sources: [npm public package publishing](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)
and [npm two-factor authentication](https://docs.npmjs.com/configuring-two-factor-authentication/).

## Tokenless subsequent releases

1. In GitHub repository Settings > Environments, create `npm`. Restrict it to
   `master` and add a maintainer as required reviewer. Do not add an npm token.
2. In the npm package Settings > Trusted publishing, add GitHub Actions with:

   | Field | Value |
   | --- | --- |
   | Organization/user | `Fogito-com` |
   | Repository | `fogipass-cli` |
   | Workflow filename | `publish.yml` |
   | Environment | `npm` |
   | Allowed action | Direct `npm publish` |

3. Prepare a new version in `package.json`, `lib/client.js` and the lockfile,
   test on `alpha`, then promote to `master`. Wait for that commit's CI to pass.
4. Run **Actions > Publish npm package > Run workflow**, select `master`, and enter
   its exact version. Approve the environment gate. The workflow uses short-lived
   OIDC credentials and provenance, without a stored publishing token.
5. Validate a new trusted publisher within two days by completing a successful
   publish. After verification, set npm publishing access to **Require two-factor
   authentication and disallow tokens**.

Source: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Release safety

Never publish from an unreviewed branch or a checkout containing local secrets.
The npm `files` allowlist is verified before publication and excludes Python,
tests, deployment files, local environments, lockfiles and all Git history.
No install/postinstall hook runs. Pin dependencies, retain `package-lock.json` in
Git and rerun secret scans before every push. Do not relax keychain requirements.

If a release needs rollback, restore the previous tested npm distribution tag
using the owner's authenticated npm account, and deprecate the broken version.
Do not unpublish or overwrite releases automatically. If credentials might have
been exposed, revoke affected FogiPass connections from Settings as well.
