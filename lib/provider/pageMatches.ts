// Pages where zebgen exposes `window.zebgen`. Release builds only serve the real swap page;
// dev and e2e builds (`wxt`, `wxt build --mode e2e`) also allow local swap-page servers.
const PRODUCTION_PAGES = ['https://app.leakswap.com/*'];
const LOCAL_PAGES = ['http://localhost/*', 'http://127.0.0.1/*'];

export const PROVIDER_PAGE_MATCHES =
  import.meta.env.MODE === 'development' || import.meta.env.MODE === 'e2e'
    ? [...PRODUCTION_PAGES, ...LOCAL_PAGES]
    : PRODUCTION_PAGES;
