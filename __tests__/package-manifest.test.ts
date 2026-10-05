import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import semver from "semver";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));
const peers: Record<string, string> = pkg.peerDependencies ?? {};
const deps: Record<string, string> = pkg.dependencies ?? {};
const PI_PEERS = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];

describe("package-manifest: supported peer range across pi 0.84+ and 1.x", () => {
  it.each(PI_PEERS)("%s uses range >=0.84.1 <2.0.0", (name) => {
    expect(peers[name]).toBe(">=0.84.1 <2.0.0");
  });

  it.each(["0.84.1", "0.86.1", "1.0.2"])("host %s satisfies the pi peers", (v) => {
    for (const name of PI_PEERS) expect(semver.satisfies(v, peers[name])).toBe(true);
  });

  it("a 2.0.0 host is excluded", () => {
    for (const name of PI_PEERS) expect(semver.satisfies("2.0.0", peers[name])).toBe(false);
  });

  it("declares typebox peer satisfied by 1.3.7 and 1.3.27", () => {
    expect(peers.typebox).toBeDefined();
    expect(semver.satisfies("1.3.7", peers.typebox)).toBe(true);
    expect(semver.satisfies("1.3.27", peers.typebox)).toBe(true);
  });

  it("has no legacy @sinclair/typebox dependency", () => {
    expect(peers["@sinclair/typebox"]).toBeUndefined();
    expect(deps["@sinclair/typebox"]).toBeUndefined();
  });
});
