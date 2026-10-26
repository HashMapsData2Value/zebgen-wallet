const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
const browserDownloads = [...document.querySelectorAll('[data-browser-download]')];
for (const link of browserDownloads) {
  link.addEventListener('click', () => selectTab(document.getElementById(`tab-${link.dataset.browserDownload}`)));
}
async function resolveBrowserDownloads() {
  try {
    let response = await fetch('https://api.github.com/repos/HashMapsData2Value/zebgen-wallet/releases/latest', { signal: AbortSignal.timeout(8000) });
    if (response.status === 404) {
      response = await fetch('https://api.github.com/repos/HashMapsData2Value/zebgen-wallet/releases?per_page=20', { signal: AbortSignal.timeout(8000) });
    }
    if (!response.ok) throw new Error(`Release lookup failed: ${response.status}`);
    const result = await response.json();
    const release = Array.isArray(result) ? result.find(candidate => !candidate.draft) : result;
    if (!release) throw new Error('No published builds are available yet.');
    for (const link of browserDownloads) {
      const asset = release.assets?.find(asset => asset.name.endsWith(`-${link.dataset.browserDownload}.zip`));
      if (!asset) continue;
      const url = new URL(asset.browser_download_url);
      if (url.origin === 'https://github.com' && url.pathname.startsWith('/HashMapsData2Value/zebgen-wallet/releases/download/')) link.href = url.href;
    }
  } catch (error) {
    console.error('Browser downloads could not be resolved; using release page', error);
  }
}
if (browserDownloads.length) void resolveBrowserDownloads();

const chainScene = document.querySelector('.chain-strip-inner');
if (chainScene) {
  const networks = [...chainScene.querySelectorAll(':scope > div')];
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let targetX = 0;
  let targetY = 0;
  let currentX = 0;
  let currentY = 0;
  let frame = 0;
  function animateNetworks() {
    frame = 0;
    if (reducedMotion.matches) return;
    currentX += (targetX - currentX) * 0.08;
    currentY += (targetY - currentY) * 0.08;
    networks.forEach((network, index) => {
      const depth = index === 0 ? 1 : 0.65;
      network.style.setProperty('--chain-x', `${currentX * depth}px`);
      network.style.setProperty('--chain-y', `${currentY * depth}px`);
    });
    if (Math.abs(targetX - currentX) + Math.abs(targetY - currentY) > 0.05) {
      frame = requestAnimationFrame(animateNetworks);
    }
  }
  function moveNetworks(horizontal, vertical) {
    targetX = horizontal;
    targetY = vertical;
    if (!frame) frame = requestAnimationFrame(animateNetworks);
  }
  chainScene.addEventListener('pointermove', event => {
    if (reducedMotion.matches || (event.pointerType === 'touch' && !event.buttons)) return;
    const bounds = chainScene.getBoundingClientRect();
    moveNetworks(((event.clientX - bounds.left) / bounds.width - 0.5) * 48,
      ((event.clientY - bounds.top) / bounds.height - 0.5) * 28);
  });
  for (const eventName of ['pointerleave', 'pointerup', 'pointercancel']) {
    chainScene.addEventListener(eventName, () => moveNetworks(0, 0));
  }
  reducedMotion.addEventListener('change', () => {
    cancelAnimationFrame(frame);
    frame = 0;
    currentX = currentY = 0;
    networks.forEach(network => {
      network.style.removeProperty('--chain-x');
      network.style.removeProperty('--chain-y');
    });
  });
}

function selectTab(selected) {
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    const index = tabs.indexOf(tab);
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = tabs[(index + 1) % tabs.length];
    if (event.key === 'Home') next = tabs[0];
    if (event.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return;
    event.preventDefault();
    selectTab(next);
    next.focus();
  });
}