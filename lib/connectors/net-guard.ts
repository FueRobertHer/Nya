// lib/connectors/net-guard.ts
//
// Which network addresses Nya may connect to on a person's behalf. A connector
// reaches a URL that came from that person (SimpleFIN's Setup Token is a URL
// they paste, and the Access URL it is exchanged for names a host too), so
// the server must never be talked into calling something only it can reach:
// its own loopback, the private network around it, a cloud's metadata service
// (169.254.169.254 and its kin), or anything else that is not a public
// address on the internet. This is the rule; lib/connectors/http.ts applies it
// to every address a host name resolves to, and to every redirect.
//
// ALLOW-LIST, NOT DENY-LIST, FOR IPv6. An IPv4 address is public unless it
// falls in one of the ranges below. An IPv6 address is public only inside
// 2000::/3, the global unicast space, and then not in the parts of it that are
// documentation, protocol assignments (Teredo among them) or 6to4, which embed
// or relay other addresses. Outside it, only an address that carries an IPv4
// one (IPv4-mapped ::ffff:a.b.c.d, and NAT64's 64:ff9b::/96) is considered,
// by the IPv4 address it carries. Everything else (loopback ::1, unique local
// fc00::/7 including AWS's metadata fd00:ec2::254, link-local fe80::/10,
// multicast, the unspecified address) is refused. An address with a zone
// ("fe80::1%eth0") is refused too: it only means something on one machine.
//
// Pure and dependency-free (node:net only for its parsers' validation), so
// its tests can walk every class of address.

import { isIPv4, isIPv6 } from 'node:net';

/** IPv4 ranges that are not public addresses: [first address, prefix length]. */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // shared address space (carrier-grade NAT; Alibaba's metadata 100.100.100.200)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local: the metadata service of AWS, GCP and Azure (169.254.169.254), ECS (169.254.170.2)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments (Oracle Cloud's metadata 192.0.0.192)
  ['192.0.2.0', 24], // documentation (TEST-NET-1)
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation (TEST-NET-2)
  ['203.0.113.0', 24], // documentation (TEST-NET-3)
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and the broadcast address 255.255.255.255
];

/** An IPv4 address in dotted form as a 32-bit unsigned number, or null. */
export function ipv4ToNumber(ip: string): number | null {
  if (!isIPv4(ip)) return null;
  const parts = ip.split('.').map(Number);
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

const inRange = (n: number, base: number, bits: number): boolean => {
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (n & mask) >>> 0 === (base & mask) >>> 0;
};

const BLOCKED_V4_NUMBERS = BLOCKED_V4.map(([ip, bits]) => [ipv4ToNumber(ip)!, bits] as const);

/** Whether an IPv4 address (a 32-bit number) is a public one. */
function publicV4(n: number): boolean {
  return !BLOCKED_V4_NUMBERS.some(([base, bits]) => inRange(n, base, bits));
}

/**
 * An IPv6 address as its eight 16-bit groups, or null. Takes the "::"
 * shorthand and a dotted IPv4 tail ("::ffff:10.0.0.1"); refuses a zone
 * ("%eth0").
 */
export function ipv6Groups(ip: string): number[] | null {
  if (ip.includes('%') || !isIPv6(ip)) return null;
  let text = ip.toLowerCase();
  // A dotted IPv4 tail becomes its two groups.
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const n = ipv4ToNumber(tail[1]);
    if (n === null) return null;
    text = `${text.slice(0, -tail[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** Whether an IPv6 address (its groups) is a public one (see the header). */
function publicV6(g: number[]): boolean {
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64's well-known prefix (64:ff9b::/96)
  // carry an IPv4 address, and reach it: judged by it.
  const carried = (g[6] * 0x10000 + g[7]) >>> 0;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return publicV4(carried);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return publicV4(carried);
  // Global unicast only (2000::/3)...
  if ((g[0] & 0xe000) !== 0x2000) return false;
  // ...but not its special parts.
  if (g[0] === 0x2001 && g[1] <= 0x01ff) return false; // 2001::/23, protocol assignments (Teredo is 2001::/32)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // 2001:db8::/32, documentation
  if (g[0] === 0x2002) return false; // 2002::/16, 6to4, which embeds an IPv4 address
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return false; // 3fff::/20, documentation
  return true;
}

/**
 * Whether Nya may connect to this address on a person's behalf: a public
 * IPv4 or IPv6 address (see the header). Anything that isn't an address at
 * all is refused.
 */
export function isPublicAddress(address: string): boolean {
  const v4 = ipv4ToNumber(address);
  if (v4 !== null) return publicV4(v4);
  const v6 = ipv6Groups(address);
  return v6 !== null && publicV6(v6);
}
