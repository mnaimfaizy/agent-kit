// Contract for `agent-kit deep-scan` (cli/): the relay on an isolated network, the only route to the host (#404).
// Fixtures and the fakes behind every run: scripts/cli-deep-scan-fixtures.mjs.

import assert from "node:assert/strict";
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect as connectNet, createServer as createNetServer } from "node:net";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { MAX_REPORT_BYTES } from "../cli/src/deep-scan/lifecycle.mjs";
import { MIN_DOCKER_ENGINE } from "../cli/src/deep-scan/runtime.mjs";
import {
  OTHER_HOST_PORT,
  RELAY_IMAGE,
  RELAY_SCRIPT_FILE,
  RELAY_SCRIPT_SHA256,
  relayBuildContext,
} from "../cli/src/deep-scan/relay.mjs";
import { StepFailed } from "../cli/src/deep-scan/steps.mjs";
import { singleFileOf } from "../cli/src/deep-scan/tar.mjs";
import { copyOutScript } from "../cli/src/deep-scan/docker-driver.mjs";
import {
  VALID,
  tmp,
  n,
  ok,
  REAL_KEY,
  REPORT_TEXT,
  COPY_OUT,
  ISOLATED,
  probeOut,
  PROBE_PASS,
  CUT_PASS,
  MODEL_PASS,
  NO_REGISTRIES,
  docker,
  sbxAnswers,
  RUNC,
  KATA,
  FC,
  RUNSC,
  makeHost,
  run,
  recipeRepo,
  recipe,
  ACCEPTED_LIST,
  assertNothingStarted,
  lifecycle,
  stdinOf,
  tarEntries,
  verb,
  isAgentStep,
  isSetupStep,
  removed,
  containerOf,
  gvisorWith,
  agentCall,
  settingsOf,
  isSandboxRun,
  relayRuns,
  probeRuns,
  flagValues,
  ISOLATED_OPTS,
  scriptArgs,
  relayAddr,
  relayPort,
} from "./cli-deep-scan-fixtures.mjs";

describe("Docker Engine: the sandbox's only route to the host is a relay on an isolated network (#404)", () => {
  it("creates the sandbox's one network internal and isolated, and the relays' host network ordinary", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    const calls = lifecycle(res);
    const creates = calls.filter((a) => a[0] === "network" && a[1] === "create");
    assert.equal(creates.length, 2, creates.map((a) => a.join(" ")).join("\n"));
    const [hostNet, sandboxNet] = creates.map((a) => a.at(-1));
    const name = containerOf(calls);
    assert.equal(hostNet, `${name}-host`);
    assert.equal(sandboxNet, name);
    assert.ok(!creates[0].includes("--internal"), creates[0].join(" "));
    assert.deepEqual(flagValues(creates[0], "--opt"), []);
    assert.ok(creates[1].includes("--internal"), creates[1].join(" "));
    assert.deepEqual(flagValues(creates[1], "--opt").sort(), ISOLATED_OPTS);
  });

  it("starts a relay per proxy, on the sandbox's network and the host network, with nothing the target can use", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    const calls = lifecycle(res);
    const name = containerOf(calls);
    const relays = relayRuns(calls);
    assert.equal(relays.length, 2, relays.map((a) => a.join(" ")).join("\n"));
    for (const [relay, net, phase] of [
      [relays[0], name, "setup"],
      [relays[1], name, "model"],
    ]) {
      const line = relay.join(" ");
      assert.equal(flagValues(relay, "--name")[0], `${name}-relay-${phase}`);
      // Its default route is the host network's; the sandbox network has none.
      assert.deepEqual(flagValues(relay, "--network"), [
        `name=${name}-host,gw-priority=1`,
        `name=${net},ip=${relayAddr(relay)}`,
      ]);
      assert.ok(relay.includes("--read-only"), line);
      assert.deepEqual(flagValues(relay, "--cap-drop"), ["ALL"], line);
      assert.deepEqual(flagValues(relay, "--security-opt"), ["no-new-privileges"], line);
      assert.deepEqual(flagValues(relay, "--label"), [
        flagValues(calls.find(isSandboxRun), "--label")[0],
      ]);
      // The relay image the launcher built: the pinned node image and the script.
      assert.equal(relay[relay.indexOf("/agent-kit/relay.mjs") - 1], `${name}-relay`, line);
      assert.ok(
        !relay.some((a) => /^(-p|--publish|--privileged|-v|--volume|--env|-e|--cap-add)$/.test(a)),
        line,
      );
      assert.deepEqual(flagValues(relay, "--mount"), [], "no host path is mounted");
      // One TCP port, forwarded to the host-side proxy on the host network's gateway.
      const [script, mode, listen, host, port] = scriptArgs(relay);
      assert.deepEqual([script, mode, host], ["/agent-kit/relay.mjs", "forward", "127.0.0.1"]);
      assert.match(port, /^\d+$/);
      assert.equal(listen, port);
      assert.equal(scriptArgs(relay).length, 5);
    }
  });

  it("reads the host network's IPAM configs as JSON and puts the proxies on its IPv4 gateway", async () => {
    // A dual-stack bridge: the IPv6 config first, as Docker may list it.
    const host = gvisorWith({
      "network inspect --format {{json .IPAM.Config}}": {
        status: 0,
        stdout: JSON.stringify([
          { Subnet: "fd00:db8::/64", Gateway: "fd00:db8::1" },
          { Subnet: "172.18.0.0/16", Gateway: "127.0.0.1" },
        ]),
      },
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 0, res.text);
    const calls = lifecycle(res);
    const name = containerOf(calls);
    assert.ok(
      calls.some(
        (a) => a.join(" ") === `network inspect --format {{json .IPAM.Config}} ${name}-host`,
      ),
      calls.map((a) => a.join(" ")).join("\n"),
    );
    for (const relay of relayRuns(calls)) assert.equal(scriptArgs(relay).at(-2), "127.0.0.1");
  });

  it("ends the run before the target starts when the host network has no IPv4 gateway", async () => {
    const host = gvisorWith({
      "network inspect --format {{json .IPAM.Config}}": {
        status: 0,
        stdout: JSON.stringify([{ Subnet: "fd00:db8::/64", Gateway: "fd00:db8::1" }]),
      },
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(
      res.err,
      /FAILED {2}the relays' host network has no IPv4 gateway address to put a proxy on\./,
    );
    assert.ok(!lifecycle(res).some(isSandboxRun));
  });

  it("builds the relay image once, on stdin, from the pinned node image and the checked script", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    const calls = lifecycle(res);
    const name = containerOf(calls);
    const isRelayBuild = (a) => a[0] === "build" && flagValues(a, "--tag")[0] === `${name}-relay`;
    const builds = calls.filter(isRelayBuild);
    assert.equal(builds.length, 1, calls.map((a) => a.join(" ")).join("\n"));
    assert.equal(builds[0].at(-1), "-", "the context comes on stdin, not from a host folder");
    assert.deepEqual(flagValues(builds[0], "--label"), [
      flagValues(calls.find(isSandboxRun), "--label")[0],
    ]);
    const context = tarEntries(stdinOf(res, isRelayBuild));
    assert.deepEqual(
      context.map((e) => e.name),
      ["Dockerfile", "relay.mjs"],
    );
    assert.equal(
      context[0].data.toString("utf8"),
      `FROM ${RELAY_IMAGE}\nCOPY relay.mjs /agent-kit/relay.mjs\n`,
    );
    assert.deepEqual(context[1].data, readFileSync(RELAY_SCRIPT_FILE));
    // Built before the first relay, and every relay and probe runs it.
    assert.ok(calls.findIndex(isRelayBuild) < calls.findIndex((a) => relayRuns([a]).length));
    for (const a of [...relayRuns(calls), ...probeRuns(calls)]) {
      assert.equal(a[a.indexOf("/agent-kit/relay.mjs") - 1], `${name}-relay`);
    }
  });

  it("ends the run before the target starts when the relay image cannot be built", async () => {
    const host = gvisorWith({
      "~-relay -": { status: 1, stderr: "pull access denied\n" },
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /FAILED {2}building the relay image: pull access denied/);
    const calls = lifecycle(res);
    assert.ok(!calls.some(isSandboxRun));
    assert.equal(relayRuns(calls).length, 0);
  });

  it("never gives a relay or a probe the model credential", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    const calls = lifecycle(res);
    const text = JSON.stringify([...relayRuns(calls), ...probeRuns(calls)]);
    assert.ok(!text.includes(REAL_KEY));
    assert.doesNotMatch(text, /ANTHROPIC|CLAUDE_CODE|--env/);
  });

  it("sends setup and the model route to the relay's address, never the host's", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    const calls = lifecycle(res);
    const [setupRelay, modelRelay] = relayRuns(calls);
    for (const step of calls.filter(isSetupStep)) {
      assert.ok(
        step.includes(`HTTPS_PROXY=http://${relayAddr(setupRelay)}:${relayPort(setupRelay)}`),
        step.join(" "),
      );
    }
    const settings = settingsOf(agentCall(calls));
    assert.equal(
      settings.env.ANTHROPIC_BASE_URL,
      `http://${relayAddr(modelRelay)}:${relayPort(modelRelay)}`,
    );
    assert.match(res.out, /Setup: egress limited to registry\.npmjs\.org.*through a relay/);
    assert.match(
      res.out,
      /Model route: only the model proxy on your machine \(through a relay on the isolated network agent-kit-deep-[0-9a-f]+\)/,
    );
  });

  it("checks from the host before the target starts, after the cut and before the agent step", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    const calls = lifecycle(res);
    const name = containerOf(calls);
    const at = (pred, from = 0) => {
      const i = calls.findIndex((a, j) => j >= from && pred(a));
      assert.ok(i >= 0, `${pred} after ${from}: ${calls.map(verb).join(", ")}`);
      return i;
    };
    const inspectNet = (a) =>
      a[0] === "network" && a[1] === "inspect" && a.includes("{{json .}}") && a.at(-1) === name;
    const probeNamed = (phase) => (a) => flagValues(a, "--name")[0] === `${name}-probe-${phase}`;
    const onAlone = (a) => a[0] === "container" && a[1] === "inspect" && a.at(-1) === name;
    // Before the target starts: the network, the relay, the probe, the sandbox, where it is.
    const setupProbe = at(probeNamed("setup"), at(inspectNet));
    const sandbox = at(isSandboxRun, setupProbe);
    const alone = at(onAlone, sandbox);
    assert.ok(alone < at(isSetupStep), "checked before the first setup step");
    // After the cut, then before the agent step: the network again, then the model probe.
    const cut = at(probeNamed("cut"), calls.findLastIndex(isSetupStep));
    const model = at(probeNamed("model"), at(inspectNet, cut));
    assert.ok(model < at(isAgentStep), "checked before the agent step");
    for (const probe of probeRuns(calls)) {
      assert.equal(flagValues(probe, "--network").length, 1);
      assert.ok(flagValues(probe, "--network")[0].startsWith(`name=${name},ip=`));
      assert.ok(probe.includes("--read-only"));
      assert.deepEqual(flagValues(probe, "--cap-drop"), ["ALL"]);
    }
    const port = relayPort(relayRuns(calls)[0]);
    assert.deepEqual(scriptArgs(calls[setupProbe]), [
      "/agent-kit/relay.mjs",
      "probe",
      relayAddr(relayRuns(calls)[0]),
      port,
      "127.0.0.1",
      port,
      "127.0.0.1",
      "22",
    ]);
  });

  const failCases = [
    [
      "a setup network that has a gateway address",
      {
        "network inspect --format {{json .}}": {
          status: 0,
          stdout: JSON.stringify({
            ...ISOLATED,
            IPAM: { Config: [{ Subnet: "172.30.0.0/16", Gateway: "172.30.0.1" }] },
          }),
        },
      },
      /FAILED {2}the setup network is not isolated: docker network inspect shows the gateway address 172\.30\.0\.1\./,
    ],
    [
      "a setup network not in isolated mode",
      {
        "network inspect --format {{json .}}": {
          status: 0,
          stdout: JSON.stringify({ ...ISOLATED, Options: {} }),
        },
      },
      /FAILED {2}the setup network is not isolated: docker network inspect shows com\.docker\.network\.bridge\.gateway_mode_ipv4 as "", not isolated\./,
    ],
    [
      "a setup network that is not internal",
      {
        "network inspect --format {{json .}}": {
          status: 0,
          stdout: JSON.stringify({ ...ISOLATED, Internal: false }),
        },
      },
      /FAILED {2}the setup network is not isolated: docker network inspect shows it is not internal\./,
    ],
    [
      "a probe that reaches the host on the proxy's port",
      {
        "~-probe-setup --label": {
          status: 0,
          stdout: probeOut(["connected", "connected", "unreachable"]),
        },
      },
      /FAILED {2}the setup network is not isolated: a probe on it reached the host network's gateway at 127\.0\.0\.1:\d+ \(connected\)\./,
    ],
    [
      "a probe that reaches the host on another port",
      {
        "~-probe-setup --label": {
          status: 0,
          stdout: probeOut(["connected", "unreachable", "refused"]),
        },
      },
      /FAILED {2}the setup network is not isolated: a probe on it reached the host network's gateway at 127\.0\.0\.1:22 \(refused\)\./,
    ],
    [
      "a probe that cannot reach the relay",
      {
        "~-probe-setup --label": {
          status: 0,
          stdout: probeOut(["unreachable", "unreachable", "unreachable"]),
        },
      },
      /FAILED {2}the setup network is not isolated: a probe on it could not reach the relay at 198\.1[89]\.\d{1,3}\.10:\d+ \(unreachable\)\./,
    ],
    [
      "a probe whose answer is not its own addresses and one result per target",
      { "~-probe-setup --label": { status: 0, stdout: "hello\n" } },
      /FAILED {2}the setup network is not isolated: the probe's answer is not its own addresses and one result per target\./,
    ],
    [
      "a probe that fails",
      { "~-probe-setup --label": { status: 125, stderr: "probe: boom\n" } },
      /FAILED {2}probing the sandbox's network \(setup\): probe: boom/,
    ],
  ];
  for (const [name, extra, message] of failCases) {
    it(`ends the run before the target starts on ${name}, and tears down`, async () => {
      const res = await run(recipeRepo(VALID), [], { host: gvisorWith(extra) });
      assert.equal(res.code, 1, res.text);
      assert.match(res.err, message);
      assert.match(res.err, /The run ends here, before the agent step\./);
      const calls = lifecycle(res);
      assert.ok(!calls.some(isSandboxRun), "the sandbox never started");
      assert.ok(!calls.some(isAgentStep));
      assert.ok(removed(calls).some((a) => a[0] === "network" && a[2].endsWith("-host")));
    });
  }

  it("ends the run before the target starts when the sandbox is on another network too", async () => {
    const host = gvisorWith({
      "container inspect --format {{json .NetworkSettings.Networks}}": {
        status: 0,
        stdout: '{"bridge":{}}\n',
      },
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(
      res.err,
      /FAILED {2}the sandbox is not on the setup network alone: docker inspect shows the sandbox on bridge\./,
    );
    assert.ok(!lifecycle(res).some(isSetupStep), "no setup step ran");
  });

  it("ends the run before the agent step when the model probe reaches the host", async () => {
    const host = gvisorWith({
      "~-probe-model --label": {
        status: 0,
        stdout: probeOut(["connected", "unreachable", "connected", "unreachable"]),
      },
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(
      res.err,
      /FAILED {2}more than the model route is open: a probe on it reached the host network's gateway at 127\.0\.0\.1:\d+ \(connected\)\./,
    );
    const calls = lifecycle(res);
    assert.ok(calls.some(isSetupStep), "setup ran");
    assert.ok(!calls.some(isAgentStep), "the agent step never ran");
    assert.doesNotMatch(res.out, /before the agent step; the sandbox reaches/);
  });

  it("checks the network with no setup relay when the recipe lists no registries", async () => {
    const text = recipe({ drop: ["registries"], add: "registries: []" });
    const res = await run(recipeRepo(text), [], { host: gvisorWith(NO_REGISTRIES) });
    assert.equal(res.code, 0, res.text);
    const calls = lifecycle(res);
    const name = containerOf(calls);
    const creates = calls
      .filter((a) => a[0] === "network" && a[1] === "create")
      .map((a) => a.at(-1));
    assert.deepEqual(creates, [`${name}-host`, name]);
    assert.equal(relayRuns(calls).length, 1, "the model relay alone");
    assert.deepEqual(
      probeRuns(calls).map((a) => scriptArgs(a).slice(2)),
      [
        ["127.0.0.1", "22"],
        ["127.0.0.1", "22"],
        [
          relayAddr(relayRuns(calls)[0]),
          relayPort(relayRuns(calls)[0]),
          "127.0.0.1",
          relayPort(relayRuns(calls)[0]),
          "127.0.0.1",
          "22",
        ],
      ],
    );
    assert.deepEqual(flagValues(calls.find(isSandboxRun), "--network"), [name]);
  });

  it("removes the relays, the probes and the host network on success, the sandbox first", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    const calls = lifecycle(res);
    const name = containerOf(calls);
    const build = calls.find((a) => a[0] === "build");
    assert.deepEqual(removed(calls), [
      ["rm", "--force", "--volumes", name],
      ["rm", "--force", "--volumes", `${name}-probe-model`],
      ["rm", "--force", "--volumes", `${name}-relay-model`],
      ["rm", "--force", "--volumes", `${name}-probe-cut`],
      ["rm", "--force", "--volumes", `${name}-probe-setup`],
      ["rm", "--force", "--volumes", `${name}-relay-setup`],
      ["image", "rm", "--force", `${name}-relay`],
      ["network", "rm", name],
      ["network", "rm", `${name}-host`],
      ["image", "rm", "--force", build[build.indexOf("--tag") + 1]],
    ]);
  });

  it("removes what was created when the setup relay cannot start", async () => {
    const host = gvisorWith({ "~-relay-setup --label": { status: 125, stderr: "relay: boom\n" } });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /FAILED {2}starting the setup relay: relay: boom/);
    const calls = lifecycle(res);
    assert.ok(!calls.some(isSandboxRun));
    const name = flagValues(relayRuns(calls)[0], "--name")[0].replace(/-relay-setup$/, "");
    assert.deepEqual(
      removed(calls).map((a) => a.at(-1)),
      [`${name}-relay-setup`, `${name}-relay`, name, `${name}-host`, name],
    );
  });

  it("removes the probe and the relay on an interrupt during the probe", async () => {
    const host = gvisorWith({ "~-probe-setup --label": { hang: true } });
    const signals = new EventEmitter();
    const res = await run(recipeRepo(VALID), [], {
      host,
      signals,
      onSpawn: (cmd, args, child) => {
        if (args[0] === "run" && args[1] === "--rm") {
          child.stdout.once("data", () => signals.emit("SIGINT"));
        }
      },
    });
    assert.equal(res.code, 130, res.text);
    const calls = lifecycle(res);
    assert.ok(!calls.some(isSandboxRun));
    assert.deepEqual(
      removed(calls).map((a) => a.at(-1).replace(/^agent-kit-deep-[0-9a-f]+/, "")),
      ["-probe-setup", "-relay-setup", "-relay", "", "-host", ""],
    );
  });

  it("removes the model relay and probe when the agent step fails", async () => {
    const host = gvisorWith({ "~set -eu": { status: 2 } });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    const gone = removed(lifecycle(res)).map((a) => a.at(-1));
    assert.ok(
      gone.some((n) => n.endsWith("-relay-model")),
      gone.join(", "),
    );
    assert.ok(
      gone.some((n) => n.endsWith("-probe-model")),
      gone.join(", "),
    );
  });

  it("says when the isolation check passed, before the target starts and before the agent step", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    const lines = res.out.split("\n");
    const at = (re) => lines.findIndex((l) => re.test(l));
    const setup = at(
      /^Isolation: checked from the host before the target starts; the sandbox reaches only the setup relay's port\.$/,
    );
    const model = at(
      /^Isolation: checked from the host before the agent step; the sandbox reaches only the model relay's port\.$/,
    );
    assert.ok(setup >= 0 && model >= 0, res.out);
    assert.ok(setup < at(/^Copied in: /), "before anything of the target's goes in");
    assert.ok(at(/^Setup: setup\[0\] ok/) < model && model < at(/^Agent step: /), res.out);
  });

  it(
    "checks the report in the sandbox with a real sh, then tars that one file",
    { skip: process.platform === "win32" && "needs a POSIX sh and symbolic links" },
    () => {
      const dir = mkdtempSync(join(tmp, "copy-out-"));
      const sh = (path, max) => spawnSync("sh", ["-c", copyOutScript(path, max)]);
      writeFileSync(join(dir, "report.md"), REPORT_TEXT);
      const ok = sh(join(dir, "report.md"), 1024);
      assert.equal(ok.status, 0, ok.stderr.toString());
      assert.deepEqual(singleFileOf(ok.stdout, { maxBytes: 1024 }), {
        name: "report.md",
        data: Buffer.from(REPORT_TEXT),
      });
      assert.equal(sh(join(dir, "missing.md"), 1024).status, 3);
      mkdirSync(join(dir, "folder.md"));
      assert.equal(sh(join(dir, "folder.md"), 1024).status, 4);
      symlinkSync(join(dir, "report.md"), join(dir, "link.md"));
      assert.equal(sh(join(dir, "link.md"), 1024).status, 4);
      assert.equal(sh(join(dir, "report.md"), 4).status, 5);
    },
  );

  for (const [label, text, extra] of [
    ["with registries", VALID, {}],
    ["with no registries", recipe({ drop: ["registries"], add: "registries: []" }), NO_REGISTRIES],
  ]) {
    it(`never connects or disconnects the sandbox's network after docker run, ${label}`, async () => {
      // Under gVisor a running sandbox never sees a hot-plugged network.
      const res = await run(recipeRepo(text), [], { host: gvisorWith(extra) });
      assert.equal(res.code, 0, res.text);
      const calls = lifecycle(res);
      const name = containerOf(calls);
      assert.ok(
        !calls.some((a) => a[0] === "network" && (a[1] === "connect" || a[1] === "disconnect")),
        calls.map((a) => a.join(" ")).join("\n"),
      );
      const sandbox = calls.find(isSandboxRun);
      assert.deepEqual(flagValues(sandbox, "--network"), [name]);
      // Both relays live on that one network, the sandbox's.
      for (const relay of relayRuns(calls)) {
        assert.ok(flagValues(relay, "--network")[1].startsWith(`name=${name},ip=`));
      }
    });
  }

  it("cuts setup by removing the setup relay, and proves the cut with a probe", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    const calls = lifecycle(res);
    const name = containerOf(calls);
    const lastSetup = calls.findLastIndex(isSetupStep);
    const rm = calls.findIndex(
      (a, i) => i > lastSetup && a.join(" ") === `rm --force ${name}-relay-setup`,
    );
    const cut = calls.findIndex((a) => flagValues(a, "--name")[0] === `${name}-probe-cut`);
    const modelRelay = calls.findIndex((a) => flagValues(a, "--name")[0] === `${name}-relay-model`);
    assert.ok(lastSetup < rm && rm < cut && cut < modelRelay, calls.map(verb).join(", "));
    const [setupRelay] = relayRuns(calls);
    const port = relayPort(setupRelay);
    assert.deepEqual(scriptArgs(calls[cut]), [
      "/agent-kit/relay.mjs",
      "probe",
      relayAddr(setupRelay),
      port,
      "127.0.0.1",
      port,
      "127.0.0.1",
      "22",
    ]);
    assert.match(res.out, /Network: cut \(checked from the host\)/);
  });

  it("ends the run before the agent step when the cut probe still reaches the setup relay", async () => {
    const host = gvisorWith({
      "~-probe-cut --label": {
        status: 0,
        stdout: probeOut(["connected", "unreachable", "unreachable"]),
      },
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(
      res.err,
      /FAILED {2}the network is not cut: a probe on it reached the removed setup relay at 198\.1[89]\.\d{1,3}\.10:\d+ \(connected\)\./,
    );
    const calls = lifecycle(res);
    assert.ok(!calls.some(isAgentStep), "the agent step never ran");
    assert.equal(relayRuns(calls).length, 1, "the model relay never started");
    assert.ok(removed(calls).some((a) => a[0] === "network" && a[2].endsWith("-host")));
  });

  it("checks the model route with a probe that reaches the model relay alone", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    const calls = lifecycle(res);
    const name = containerOf(calls);
    const [setupRelay, modelRelay] = relayRuns(calls);
    const probe = calls.find((a) => flagValues(a, "--name")[0] === `${name}-probe-model`);
    assert.deepEqual(scriptArgs(probe), [
      "/agent-kit/relay.mjs",
      "probe",
      relayAddr(modelRelay),
      relayPort(modelRelay),
      relayAddr(setupRelay),
      relayPort(setupRelay),
      "127.0.0.1",
      relayPort(modelRelay),
      "127.0.0.1",
      "22",
    ]);
    assert.ok(calls.indexOf(probe) < calls.findIndex(isAgentStep));
  });

  it("runs every probe under the sandbox's own runtime, and the relays under Docker's default", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    const calls = lifecycle(res);
    assert.equal(probeRuns(calls).length, 3);
    for (const probe of probeRuns(calls)) {
      assert.deepEqual(flagValues(probe, "--runtime"), ["runsc"], probe.join(" "));
    }
    for (const relay of relayRuns(calls)) assert.deepEqual(flagValues(relay, "--runtime"), []);
  });

  it("refuses a copy-out past the report's size, reading no more of it", async () => {
    const big = Buffer.alloc(MAX_REPORT_BYTES + 1024 * 1024, 0x61);
    const host = gvisorWith({ [COPY_OUT]: { status: 0, base64: big.toString("base64") } });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(
      res.err,
      /FAILED {2}the report was not copied out: it is larger than 10 MiB \(read on the host\)\./,
    );
    assert.equal(readdirSync(res.reportDir).length, 0);
  });

  it("creates the sandbox's network on a per-run subnet, Docker's own addresses in its upper half", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    const calls = lifecycle(res);
    const create = calls.find(
      (a) => a[0] === "network" && a[1] === "create" && a.includes("--internal"),
    );
    const [subnet] = flagValues(create, "--subnet");
    assert.match(subnet, /^198\.1[89]\.\d{1,3}\.0\/24$/, create.join(" "));
    const prefix = subnet.replace(/\.0\/24$/, "");
    assert.deepEqual(flagValues(create, "--ip-range"), [`${prefix}.128/25`]);
  });

  it("gives each relay and probe its own fixed address below the dynamic range, never reused in a run", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    const calls = lifecycle(res);
    const name = containerOf(calls);
    const create = calls.find(
      (a) => a[0] === "network" && a[1] === "create" && a.includes("--internal"),
    );
    const prefix = flagValues(create, "--subnet")[0].replace(/\.0\/24$/, "");
    const owned = calls.filter((a) => relayRuns([a]).length || probeRuns([a]).length);
    const ips = owned.map((a) => {
      const net = flagValues(a, "--network").find((v) => v.startsWith(`name=${name},`));
      assert.ok(net, a.join(" "));
      return [flagValues(a, "--name")[0].slice(name.length), net.slice(`name=${name},ip=`.length)];
    });
    assert.deepEqual(ips, [
      ["-relay-setup", `${prefix}.10`],
      ["-probe-setup", `${prefix}.11`],
      ["-probe-cut", `${prefix}.12`],
      ["-relay-model", `${prefix}.13`],
      ["-probe-model", `${prefix}.14`],
    ]);
    // The sandbox takes Docker's own pick, from the upper half.
    assert.deepEqual(flagValues(calls.find(isSandboxRun), "--network"), [name]);
    // Each probe's targets are those fixed addresses, and the gateway.
    const cut = owned.find((a) => flagValues(a, "--name")[0].endsWith("-probe-cut"));
    assert.equal(scriptArgs(cut)[2], `${prefix}.10`);
  });

  it("tries another subnet when one overlaps, and fails cleanly when none is free", async () => {
    const host = gvisorWith({
      "network create --internal": {
        status: 1,
        stderr:
          "Error response from daemon: invalid pool request: Pool overlaps with other one on this address space\n",
      },
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    const creates = lifecycle(res).filter(
      (a) => a[0] === "network" && a[1] === "create" && a.includes("--internal"),
    );
    const subnets = creates.map((a) => flagValues(a, "--subnet")[0]);
    assert.equal(subnets.length, 5);
    assert.equal(new Set(subnets).size, 5, subnets.join(", "));
    assert.match(
      res.err,
      new RegExp(
        `FAILED {2}no free subnet for the sandbox's network: tried ${subnets.map((x) => x.replaceAll(".", "\\.")).join(", ")}, and each overlaps a network on this host\\.`,
      ),
    );
    assert.ok(!lifecycle(res).some(isSandboxRun));
  });

  it("does not retry another subnet on any other network-create error", async () => {
    const host = gvisorWith({ "network create --internal": { status: 1, stderr: "boom\n" } });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /FAILED {2}creating the setup network: boom/);
    const creates = lifecycle(res).filter(
      (a) => a[0] === "network" && a[1] === "create" && a.includes("--internal"),
    );
    assert.equal(creates.length, 1);
  });

  it("fails closed, never 'reached', when the cut probe's own address is the removed relay's", async () => {
    const host = gvisorWith({
      "~-probe-cut --label": { status: 0, selfIsTarget: 0, results: CUT_PASS },
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(
      res.err,
      /FAILED {2}the network is not cut: the probe's own address 198\.1[89]\.\d+\.10 is one of its targets, so it cannot tell a route from itself\./,
    );
    assert.doesNotMatch(res.err, /reached/);
    assert.ok(!lifecycle(res).some(isAgentStep));
  });

  it("fails closed when the model probe's own address is one of its targets", async () => {
    const host = gvisorWith({
      "~-probe-model --label": { status: 0, selfIsTarget: 1, results: MODEL_PASS },
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(
      res.err,
      /FAILED {2}more than the model route is open: the probe's own address 198\.1[89]\.\d+\.10 is one of its targets, so it cannot tell a route from itself\./,
    );
    assert.ok(!lifecycle(res).some(isAgentStep));
  });

  it("fails closed when a probe does not say its own addresses", async () => {
    const host = gvisorWith({
      "~-probe-setup --label": { status: 0, stdout: `${JSON.stringify(PROBE_PASS)}\n` },
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(
      res.err,
      /FAILED {2}the setup network is not isolated: the probe's answer is not its own addresses and one result per target\./,
    );
  });

  it("says nothing of isolation when a check fails", async () => {
    const host = gvisorWith({
      "~-probe-setup --label": {
        status: 0,
        stdout: probeOut(["connected", "connected", "unreachable"]),
      },
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.doesNotMatch(res.out, /^Isolation: /m);
  });

  it("prints no Note: about other host services: the route reaches the relay alone", async () => {
    const res = await run(recipeRepo(VALID));
    assert.equal(res.code, 0, res.text);
    // The fixture's image is a bare tag, so the image-digest note is expected.
    assert.doesNotMatch(res.text, /^Note:(?! the recipe's image )/m);
    assert.doesNotMatch(res.text, /can also reach any other service/);
  });
});

describe("the docs say what is now true of the route to the host (#404)", () => {
  const root = join(import.meta.dirname, "..");
  const read = (path) => readFileSync(join(root, path), "utf8");
  const files = [
    "docs/security-audit.md",
    "docs/security-model.md",
    "cli/README.md",
    "security/threat-model.md",
    ".github/workflows/deep-scan-reusable.yml",
  ];

  it("no longer say the sandbox can reach other services on the host", () => {
    for (const path of files) {
      const text = read(path);
      assert.doesNotMatch(text, /A limit of Docker Engine and Docker Desktop/, path);
      assert.doesNotMatch(text, /also reach(es)? (any )?other service/, path);
      assert.doesNotMatch(text, /prints a `Note:`/, path);
    }
  });

  it("describe the isolated network, the relay and the checks", () => {
    const audit = read("docs/security-audit.md");
    for (const fact of [
      "Docker Engine 28.0 or later",
      "`isolated` gateway mode",
      "com.docker.network.bridge.gateway_mode_ipv4=isolated",
      "`gw-priority`",
      "pinned by digest",
      "pinned SHA-256",
      "no capabilities, a read-only root filesystem",
      "your key never enters it",
      "`docker network inspect`",
      "a probe container",
      "On macOS, use Docker Sandboxes",
    ]) {
      assert.ok(audit.includes(fact), `docs/security-audit.md says ${fact}`);
    }
    // The constants the page copies by hand.
    assert.ok(audit.includes(`on port ${OTHER_HOST_PORT}`), "the probe's other port");
    const min = `Docker Engine ${MIN_DOCKER_ENGINE.major}.${MIN_DOCKER_ENGINE.minor} or later`;
    for (const path of ["docs/security-audit.md", "cli/README.md", "security/threat-model.md"]) {
      assert.ok(read(path).includes(min), `${path} names ${min}`);
    }
  });
});

describe("the relay script: digest-checked, built in, Node core only (#404)", () => {
  const source = () => readFileSync(RELAY_SCRIPT_FILE);

  it("is pinned by its SHA-256, and the image by its digest", () => {
    assert.equal(createHash("sha256").update(source()).digest("hex"), RELAY_SCRIPT_SHA256);
    assert.match(RELAY_IMAGE, /^node:\d+\.\d+\.\d+-alpine[\d.]+@sha256:[0-9a-f]{64}$/);
  });

  it("imports Node core alone, and listens on one port", () => {
    const text = source().toString("utf8");
    const imports = [...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    assert.ok(imports.length > 0);
    for (const i of imports) assert.match(i, /^node:/);
    assert.equal(text.match(/\.listen\(/g)?.length, 1);
  });

  it("puts the checked bytes in the relay image's build context", () => {
    const context = tarEntries(relayBuildContext());
    assert.deepEqual(
      context.map((e) => [e.name, e.type]),
      [
        ["Dockerfile", "0"],
        ["relay.mjs", "0"],
      ],
    );
    assert.deepEqual(context[1].data, source());
  });

  it("refuses a script that does not match its pinned digest", () => {
    const dir = mkdtempSync(join(tmp, "relay-"));
    const tampered = join(dir, "relay.mjs");
    writeFileSync(tampered, `${source().toString("utf8")}\n// changed\n`);
    assert.throws(
      () => relayBuildContext({ source: tampered }),
      (e) =>
        e instanceof StepFailed &&
        /FAILED {2}the relay script does not match its pinned SHA-256/.test(e.lines.join("\n")),
    );
  });

  /** Run the relay script with node, as its container does; resolve on its first line. */
  const node = (args) => {
    const child = spawnChild(process.execPath, [RELAY_SCRIPT_FILE, ...args]);
    const first = new Promise((resolve, reject) => {
      let text = "";
      child.stdout.on("data", (d) => {
        text += d;
        if (text.includes("\n")) resolve(text.split("\n")[0]);
      });
      child.on("error", reject);
      child.on("close", (code) => resolve(text.split("\n")[0] || `exit ${code}`));
    });
    return { child, first };
  };
  const freePort = async () => {
    const s = createNetServer();
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const { port } = s.address();
    await new Promise((r) => s.close(r));
    return port;
  };

  it("forwards its one port to the target, both ways", async () => {
    const target = createNetServer((socket) => {
      // The relay is killed at the end: a reset then is not the test's.
      socket.on("error", () => {});
      socket.on("data", (d) => socket.end(`echo ${d}`));
    });
    await new Promise((r) => target.listen(0, "127.0.0.1", r));
    const listen = await freePort();
    const relay = node(["forward", String(listen), "127.0.0.1", String(target.address().port)]);
    try {
      assert.equal(await relay.first, `relay: listening on ${listen}`);
      const answer = await new Promise((resolve, reject) => {
        const socket = connectNet(listen, "127.0.0.1", () => socket.write("hi"));
        let text = "";
        socket.on("data", (d) => (text += d));
        socket.on("end", () => resolve(text));
        socket.on("error", reject);
      });
      assert.equal(answer, "echo hi");
    } finally {
      relay.child.kill();
      target.close();
    }
  });

  it("keeps the whole reply when the client half-closes and the target ends at once", async () => {
    // The target reads the request to its end, then writes a large reply
    // and closes straight away: the relay must still deliver every byte.
    const reply = Buffer.alloc(8 * 1024 * 1024, 0x61);
    const target = createNetServer({ allowHalfOpen: true }, (socket) => {
      socket.on("error", () => {});
      socket.resume();
      socket.on("end", () => socket.end(reply));
    });
    await new Promise((r) => target.listen(0, "127.0.0.1", r));
    const listen = await freePort();
    const relay = node(["forward", String(listen), "127.0.0.1", String(target.address().port)]);
    try {
      await relay.first;
      const got = await new Promise((resolve, reject) => {
        const socket = connectNet({ port: listen, host: "127.0.0.1", allowHalfOpen: true }, () =>
          socket.end("request"),
        );
        let size = 0;
        socket.on("data", (d) => (size += d.length));
        socket.on("end", () => resolve(size));
        socket.on("error", reject);
      });
      assert.equal(got, reply.length);
    } finally {
      relay.child.kill();
      target.close();
    }
  });

  it("probes each target: connected, refused or unreachable", async () => {
    const open = createNetServer((socket) => socket.destroy());
    await new Promise((r) => open.listen(0, "127.0.0.1", r));
    const closed = await freePort();
    // 192.0.2.1 is TEST-NET-1: never routed, so it times out or is unreachable.
    const probe = node([
      "probe",
      "--timeout-ms",
      "300",
      "127.0.0.1",
      String(open.address().port),
      "127.0.0.1",
      String(closed),
      "192.0.2.1",
      "9",
    ]);
    try {
      const answer = JSON.parse(await probe.first);
      assert.deepEqual(answer.results, ["connected", "refused", "unreachable"]);
      assert.ok(Array.isArray(answer.self), "it names its own addresses");
    } finally {
      open.close();
    }
  });
});

describe("Docker Engine 28.0 or later is required for Kata, Firecracker and gVisor (#404)", () => {
  for (const [label, cli, runtimes] of [
    ["gVisor", { runsc: ok("runsc version release-20251110.0\n") }, RUNSC],
    ["Kata", { "kata-runtime": ok("kata-runtime  : 3.10.1\n") }, KATA],
    ["Firecracker", { firecracker: ok("Firecracker v1.10.1\n") }, FC],
  ]) {
    it(`refuses ${label} on Docker Engine 27.5.1, naming the found and the minimum versions`, async () => {
      const host = makeHost("linux", {
        ...cli,
        docker: docker({ version: "27.5.1", runtimes: { ...RUNC, ...runtimes } }),
      });
      const res = await run(recipeRepo(VALID), [], { host });
      assert.equal(res.code, 1, res.text);
      assert.match(
        res.err,
        /REFUSED {2}Docker Engine 27\.5\.1 is older than 28\.0, the oldest deep-scan runs .+ on: from 28\.0 a sandbox network can leave the host no address on it\./,
      );
      assert.match(
        res.err,
        /Upgrade Docker Engine to 28\.0 or later, or use Docker Sandboxes \(sbx\)\./,
      );
      assert.match(res.err, ACCEPTED_LIST);
      assertNothingStarted(res);
    });
  }

  it("refuses a Docker Engine whose version it cannot read", async () => {
    const host = makeHost("linux", {
      docker: docker({ version: "", runtimes: { ...RUNC, ...RUNSC } }),
      runsc: ok("runsc version release-20251110.0\n"),
    });
    const res = await run(recipeRepo(VALID), [], { host });
    assert.equal(res.code, 1, res.text);
    assert.match(res.err, /REFUSED {2}Docker Engine's version is unknown \(docker info shows ""\)/);
    assertNothingStarted(res);
  });

  for (const version of ["28.0.0", "29.1.2", "28.0.0-rc.1"]) {
    it(`accepts Docker Engine ${version}`, async () => {
      const host = makeHost("linux", {
        docker: docker({ version, runtimes: { ...RUNC, ...RUNSC } }),
        runsc: ok("runsc version release-20251110.0\n"),
      });
      const res = await run(recipeRepo(VALID), [], { host });
      assert.equal(res.code, 0, res.text);
    });
  }

  it("needs no Docker Engine version for Docker Sandboxes", async () => {
    const res = await run(recipeRepo(VALID), [], {
      host: makeHost("linux", { sbx: sbxAnswers(), docker: docker({ version: "20.10.0" }) }),
    });
    assert.equal(res.code, 0, res.text);
  });
});

describe("Docker Desktop on macOS is not a runtime deep-scan picks: a Mac uses Docker Sandboxes (#404)", () => {
  for (const [name, clis] of [
    [
      "Docker Desktop alone",
      { docker: docker({ os: "Docker Desktop", kernel: "6.10.14-linuxkit" }) },
    ],
    [
      "Docker Desktop whose VM has gVisor",
      {
        docker: docker({ os: "Docker Desktop", runtimes: { ...RUNC, ...RUNSC } }),
        runsc: ok("runsc version\n"),
      },
    ],
    ["nothing installed", {}],
  ]) {
    it(`refuses a Mac with ${name}, naming Docker Sandboxes`, async () => {
      const res = await run(recipeRepo(VALID), [], { host: makeHost("darwin", clis) });
      assert.equal(res.code, 1, res.text);
      assert.match(res.err, /On macOS, deep-scan runs on Docker Sandboxes \(sbx\)/);
      assert.match(res.err, ACCEPTED_LIST);
      assertNothingStarted(res);
    });
  }

  it("runs a Mac with Docker Sandboxes on it", async () => {
    const res = await run(recipeRepo(VALID), [], {
      host: makeHost("darwin", {
        sbx: sbxAnswers(),
        docker: docker({ os: "Docker Desktop", kernel: "6.10.14-linuxkit" }),
      }),
    });
    assert.equal(res.code, 0, res.text);
    assert.match(res.out, /Sandbox runtime: Docker Sandboxes \(sbx\)/);
  });
});
