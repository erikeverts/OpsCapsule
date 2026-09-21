const path = require("node:path");
const { app, utilityProcess } = require("electron");

const expected = "opscapsule-utility-worker-ok";
const workerPath = path.join(__dirname, "..", "dist", "terminal-worker.cjs");
const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry) => entry[1] !== undefined),
);
let output = "";
let completed = false;

function fail(message) {
  if (completed) {
    return;
  }
  completed = true;
  console.error(message);
  app.exit(1);
}

app.whenReady().then(() => {
  const worker = utilityProcess.fork(workerPath, [], {
    cwd: __dirname,
    env: environment,
    stdio: "pipe",
    serviceName: "OpsCapsule Terminal Worker Verification",
  });
  const timer = setTimeout(() => fail("Terminal worker verification timed out"), 10_000);

  worker.stderr?.on("data", (data) => process.stderr.write(data));
  worker.on("spawn", () => {
    worker.postMessage({ type: "initialize", isolation: { backend: "none" } });
  });
  worker.on("message", (message) => {
    if (message.type === "ready") {
      const windows = process.platform === "win32";
      worker.postMessage({
        type: "start-terminal",
        terminalId: "verification",
        verifyExecutable: false,
        launchSpec: {
          command: windows ? "cmd.exe" : "/bin/sh",
          args: windows
            ? ["/d", "/s", "/c", `echo ${expected}`]
            : ["-lc", `printf '${expected}\\n'`],
          cwd: __dirname,
          env: environment,
        },
        cols: 80,
        rows: 24,
      });
      return;
    }
    if (message.type === "terminal-data") {
      output += message.data;
      return;
    }
    if (message.type === "terminal-error" || message.type === "fatal-error") {
      fail(message.message);
      return;
    }
    if (message.type === "terminal-exit") {
      if (message.exitCode !== 0 || !output.includes(expected)) {
        fail(`Unexpected terminal result (${message.exitCode}): ${JSON.stringify(output)}`);
        return;
      }
      clearTimeout(timer);
      completed = true;
      console.log("Terminal utility-process verification passed.");
      worker.postMessage({ type: "shutdown" });
    }
  });
  worker.on("exit", (code) => {
    if (!completed) {
      fail(`Terminal worker exited unexpectedly with code ${code}`);
      return;
    }
    app.quit();
  });
});
