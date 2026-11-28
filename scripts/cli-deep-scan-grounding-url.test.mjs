// Contract for `agent-kit deep-scan` (cli/): grounding URLs are fetched on the
// host and copied into the untrusted sandbox, so a grounding fetch may reach
// only a public https:// host, on its one request, with no redirect followed.
// Fixtures and the fakes behind every run: scripts/cli-deep-scan-fixtures.mjs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  groundingUrlProblem,
  isGroundingUrl,
  isPublicAddress,
  publicHttpsFetch,
  publicLookup,
} from "../cli/src/deep-scan/grounding-url.mjs";
import {
  DOCS,
  VALID,
  run,
  recipeRepo,
  recipe,
  lifecycle,
  isAgentStep,
} from "./cli-deep-scan-fixtures.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("grounding URLs: what may be fetched", () => {
  it("tells a URL from a repository path", () => {
    for (const url of ["https://example.com/a.md", "http://example.com/", "file:///etc/passwd"]) {
      assert.ok(isGroundingUrl(url), url);
    }
    for (const path of ["docs/security.md", "README.md", "https:docs"]) {
      assert.ok(!isGroundingUrl(path), path);
    }
  });

  it("allows a public https:// page by its DNS name", () => {
    for (const url of [
      "https://example.com/guides/framework-security.md",
      "https://docs.example.org:8443/a/b?c=d",
      "https://example.com./x",
    ]) {
      assert.equal(groundingUrlProblem(url), null, url);
    }
  });

  it("refuses another scheme, an IP literal, a single-label host and localhost", () => {
    for (const [url, why] of [
      ["http://example.com/guide.md", /https:\/\//],
      ["file:///etc/passwd", /https:\/\//],
      ["ftp://example.com/x", /https:\/\//],
      ["https://169.254.169.254/latest/meta-data/", /not an IP address/],
      ["https://127.0.0.1:8080/", /not an IP address/],
      ["https://2130706433/", /not an IP address/],
      ["https://0x7f.1/", /not an IP address/],
      ["https://[::1]/", /not an IP address/],
      ["https://[fd00::1]/", /not an IP address/],
      ["https://intranet/wiki", /single-label/],
      ["https://localhost:3000/", /localhost/],
      ["https://app.localhost/", /localhost/],
      ["https://", /not a valid URL/],
    ]) {
      assert.match(groundingUrlProblem(url) ?? "", why, url);
    }
  });

  it("counts only public unicast addresses as public", () => {
    for (const address of ["93.184.215.14", "8.8.8.8", "2606:4700:4700::1111"]) {
      assert.ok(isPublicAddress(address), address);
    }
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "64:ff9b::a9fe:a9fe",
      "2002:a9fe:a9fe::1",
      "fd00:ec2::254",
      "fe80::1",
      "ff02::1",
      "not-an-address",
    ]) {
      assert.ok(!isPublicAddress(address), address);
    }
  });

  it("fails a lookup whose name resolves to a non-public address", async () => {
    for (const all of [false, true]) {
      const error = await new Promise((resolve) =>
        publicLookup("localhost", { all }, (e) => resolve(e)),
      );
      assert.equal(error?.code, "ENOTPUBLIC", `all: ${all}`);
      assert.match(error.message, /not a public address/);
    }
  });

  it("the host fetch refuses what the URL check refuses, before any connection", async () => {
    for (const url of ["http://example.com/", "https://169.254.169.254/", "https://localhost/"]) {
      await assert.rejects(publicHttpsFetch(url), /the URL must/, url);
    }
  });

  it("is the fetch deep-scan uses for grounding unless a test passes another", () => {
    const source = readFileSync(join(root, "cli/src/deep-scan.mjs"), "utf8");
    assert.match(source, /^ {2}fetch = publicHttpsFetch,$/m);
  });
});

describe("grounding URLs: the recipe check", () => {
  const cases = [
    ["an http:// URL", "http://example.com/guide.md", /grounding\[0\]: must be an https:\/\/ URL/],
    [
      "the metadata address",
      "https://169.254.169.254/latest/meta-data/",
      /grounding\[0\]: must name its host by a DNS name, not an IP address/,
    ],
    [
      "a loopback port",
      "https://127.0.0.1:8080/",
      /grounding\[0\]: must name its host by a DNS name/,
    ],
    ["a single-label host", "https://intranet/wiki", /grounding\[0\]: .*single-label/],
    ["localhost", "https://localhost:3000/", /grounding\[0\]: must name a public host/],
    ["a file:// URL", "file:///etc/passwd", /grounding\[0\]: must be an https:\/\/ URL/],
  ];
  for (const [name, url, message] of cases) {
    it(`refuses ${name} before anything is fetched`, async () => {
      const fetched = [];
      const res = await run(
        recipeRepo(recipe({ drop: ["grounding"], add: `grounding:\n  - ${url}` })),
        [],
        {
          fetch: async (u) => {
            fetched.push(u);
            return new Response("x");
          },
        },
      );
      assert.equal(res.code, 1, res.text);
      assert.match(res.err, /REFUSED {2}The Scan recipe .* is invalid:/);
      assert.match(res.err, message);
      assert.match(res.err, DOCS);
      assert.deepEqual(fetched, []);
    });
  }
});

describe("grounding URLs: redirects", () => {
  it("asks for no redirect, and ends the run before the agent step on one", async () => {
    const seen = [];
    const res = await run(recipeRepo(VALID), [], {
      fetch: async (url, init) => {
        seen.push(init.redirect);
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      },
    });
    assert.equal(res.code, 1, res.text);
    assert.deepEqual(seen, ["manual"]);
    assert.match(
      res.err,
      /FAILED {2}grounding\[0\]: could not fetch https:\/\/example\.com\/framework-security\.md: it redirects \(HTTP 302 to http:\/\/169\.254\.169\.254\/latest\/meta-data\/\); name the final https:\/\/ URL in the recipe/,
    );
    assert.ok(!lifecycle(res).some(isAgentStep));
    assert.ok(
      lifecycle(res).some((a) => a[0] === "rm"),
      "torn down",
    );
  });

  it("still fetches a public https:// page that answers directly", async () => {
    const res = await run(recipeRepo(VALID), [], {
      fetch: async () => new Response("framework guide\n"),
    });
    assert.equal(res.code, 0, res.text);
  });
});
