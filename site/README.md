# Zebgen Website

The public landing page is independent of the browser extension. It contains no
wallet access or signing code. Release links point to GitHub; no extension store
listing is implied.

Run `npm run build:site` from the repository root. Node's standard library copies
the page and existing brand assets to `site-dist/`. No dependency installation is
required for this build. `npm run build` still builds the extension, unchanged.

## Cloudflare Pages

- Repository: `zebgen`
- Root directory: repository root (leave blank)
- Framework preset: None
- Build command: `npm run build:site`
- Output directory: `site-dist`
- Environment: `NODE_VERSION=22`, `SKIP_DEPENDENCY_INSTALL=true`
- Custom domain: `zebgen.com`

The dependency-install override avoids installing extension dependencies for a
website that does not use them. This single-page site uses anchor navigation.
Google Fonts is the only third-party page resource; there are no analytics,
wallet connections or API requests. System font fallbacks remain available.

The build must not be published from `.output/chrome-mv3`; that directory is an
extension package, not the website.