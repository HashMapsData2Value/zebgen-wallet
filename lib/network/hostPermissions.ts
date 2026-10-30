import { browser } from 'wxt/browser';

// Hosts the manifest already grants; anything else needs a runtime optional_host_permissions grant.
const BUILT_IN_HOSTS = new Set(['localhost', '127.0.0.1']);

// Plain http is only acceptable where nobody on the open internet can alter the chain data a node returns.
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
  const octets = host
    .match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    ?.slice(1)
    .map(Number);
  if (!octets || octets.some((octet) => octet > 255)) return false;
  const [first, second] = octets;
  return (
    first === 127 ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function originPattern(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') {
      return null;
    }
    return `${protocol}//${hostname}/*`;
  } catch {
    return null;
  }
}

/**
 * Asks the user (in one prompt) for access to every node host not already granted.
 * Call it first thing in a click handler: browsers only show the prompt during a user
 * gesture, and Firefox drops the gesture after any earlier `await`.
 */
export async function ensureHostPermissions(urls: string[]): Promise<void> {
  const origins: string[] = [];
  for (const url of urls) {
    const pattern = originPattern(url);
    if (!pattern) {
      throw new Error(`Invalid node URL: ${url}`);
    }
    const { protocol, hostname } = new URL(url);
    if (protocol === 'http:' && !isPrivateNetworkHost(hostname)) {
      throw new Error(
        `Use https:// for ${hostname}. Unencrypted connections to remote nodes can be altered on the way, including deposit and balance data.`,
      );
    }
    if (!BUILT_IN_HOSTS.has(new URL(url).hostname) && !origins.includes(pattern)) {
      origins.push(pattern);
    }
  }
  // permissions.request resolves true without prompting when everything is already granted.
  if (origins.length > 0 && !(await browser.permissions.request({ origins }))) {
    throw new Error(`Permission to connect to ${origins.join(', ')} was declined.`);
  }
}
