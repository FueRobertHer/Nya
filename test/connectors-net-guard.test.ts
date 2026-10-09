import { describe, expect, test } from 'bun:test';
import { isPublicAddress, ipv6Groups, ipv4ToNumber } from '@/lib/connectors/net-guard';

// The addresses a connector may reach on a person's behalf
// (lib/connectors/net-guard.ts): public ones only. Every class of address a
// forged request could aim at is here, each with an address inside it and one
// just outside where that is still public.

describe('IPv4', () => {
  const blocked: [string, string][] = [
    ['this network', '0.0.0.0'],
    ['this network', '0.255.255.255'],
    ['private 10/8', '10.0.0.1'],
    ['private 10/8', '10.255.255.255'],
    ['shared address space (carrier-grade NAT)', '100.64.0.1'],
    ['Alibaba metadata', '100.100.100.200'],
    ['shared address space, last', '100.127.255.255'],
    ['loopback', '127.0.0.1'],
    ['loopback, anywhere in 127/8', '127.1.2.3'],
    ['link-local', '169.254.0.1'],
    ['AWS, GCP and Azure metadata', '169.254.169.254'],
    ['ECS task metadata', '169.254.170.2'],
    ['private 172.16/12', '172.16.0.1'],
    ['private 172.16/12, last', '172.31.255.255'],
    ['IETF protocol assignments', '192.0.0.1'],
    ['Oracle Cloud metadata', '192.0.0.192'],
    ['documentation TEST-NET-1', '192.0.2.10'],
    ['6to4 relay anycast', '192.88.99.1'],
    ['private 192.168/16', '192.168.1.1'],
    ['benchmarking', '198.18.0.1'],
    ['benchmarking, last', '198.19.255.255'],
    ['documentation TEST-NET-2', '198.51.100.7'],
    ['documentation TEST-NET-3', '203.0.113.9'],
    ['multicast', '224.0.0.1'],
    ['multicast, last', '239.255.255.255'],
    ['reserved', '240.0.0.1'],
    ['broadcast', '255.255.255.255'],
  ];
  for (const [what, ip] of blocked) {
    test(`refuses ${what}: ${ip}`, () => expect(isPublicAddress(ip)).toBe(false));
  }

  const allowed = ['1.1.1.1', '8.8.8.8', '9.255.255.255', '11.0.0.0', '100.63.255.255', '100.128.0.0', '126.255.255.255', '128.0.0.0', '169.253.255.255', '169.255.0.0', '172.15.255.255', '172.32.0.0', '192.0.1.1', '192.167.255.255', '192.169.0.0', '198.17.255.255', '198.20.0.0', '223.255.255.255', '52.94.236.248'];
  for (const ip of allowed) {
    test(`allows the public ${ip}`, () => expect(isPublicAddress(ip)).toBe(true));
  }

  test('reads dotted addresses as numbers, and nothing else', () => {
    expect(ipv4ToNumber('255.255.255.255')).toBe(0xffffffff);
    expect(ipv4ToNumber('10.0.0.1')).toBe(0x0a000001);
    expect(ipv4ToNumber('256.1.1.1')).toBeNull();
    expect(ipv4ToNumber('1.2.3')).toBeNull();
    expect(ipv4ToNumber('example.com')).toBeNull();
  });
});

describe('IPv6', () => {
  const blocked: [string, string][] = [
    ['unspecified', '::'],
    ['loopback', '::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
    ['IPv4-mapped metadata, dotted', '::ffff:169.254.169.254'],
    ['IPv4-mapped metadata, in hex', '::ffff:a9fe:a9fe'],
    ['IPv4-mapped private', '::ffff:10.1.2.3'],
    ['IPv4-compatible (deprecated)', '::10.0.0.1'],
    ['IPv4-compatible public, still not global unicast', '::8.8.8.8'],
    ['NAT64 to metadata', '64:ff9b::a9fe:a9fe'],
    ['NAT64 to a private address', '64:ff9b::10.0.0.1'],
    ['local-use NAT64', '64:ff9b:1::1'],
    ['discard-only', '100::1'],
    ['Teredo', '2001::1'],
    ['protocol assignments 2001::/23', '2001:1ff::1'],
    ['documentation 2001:db8::/32', '2001:db8::1'],
    ['6to4', '2002:a9fe:a9fe::1'],
    ['documentation 3fff::/20', '3fff::1'],
    ['documentation 3fff::/20, last', '3fff:fff:ffff::1'],
    ['unique local', 'fc00::1'],
    ['AWS metadata (unique local)', 'fd00:ec2::254'],
    ['link-local', 'fe80::1'],
    ['site-local (deprecated)', 'fec0::1'],
    ['multicast', 'ff02::1'],
    ['with a zone', 'fe80::1%eth0'],
    ['a zone on a public address', '2606:4700::1111%1'],
  ];
  for (const [what, ip] of blocked) {
    test(`refuses ${what}: ${ip}`, () => expect(isPublicAddress(ip)).toBe(false));
  }

  const allowed = ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '::ffff:1.1.1.1', '64:ff9b::808:808', '2001:200::1', '3ffe::1', '3fff:1000::1'];
  for (const ip of allowed) {
    test(`allows the public ${ip}`, () => expect(isPublicAddress(ip)).toBe(true));
  }

  test('expands the shorthand and an IPv4 tail into eight groups', () => {
    expect(ipv6Groups('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(ipv6Groups('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Groups('fe80::')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 0]);
    expect(ipv6Groups('::ffff:10.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001]);
    expect(ipv6Groups('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ipv6Groups('2001:DB8::A')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0xa]);
    expect(ipv6Groups('1::2::3')).toBeNull();
    expect(ipv6Groups('fe80::1%eth0')).toBeNull();
    expect(ipv6Groups('10.0.0.1')).toBeNull();
  });
});

test('anything that is not an address is refused', () => {
  for (const v of ['', 'localhost', 'example.com', '[::1]', '1.2.3.4.5', '0x7f000001', '2130706433', ' 8.8.8.8']) {
    expect([v, isPublicAddress(v)]).toEqual([v, false]);
  }
});
