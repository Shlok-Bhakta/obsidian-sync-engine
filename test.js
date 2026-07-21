const WebSocket = require("ws");
const http = require("http");

const CAPTURE_MS = 15_000;

function getJson(path) {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:9222${path}`, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (error) { reject(new Error(`Invalid debugger response: ${error.message}`)); }
      });
    });
    request.on("error", reject);
  });
}

function remoteValue(value) {
  if (Object.prototype.hasOwnProperty.call(value, "value")) {
    return typeof value.value === "string" ? value.value : JSON.stringify(value.value);
  }
  return value.description ?? value.unserializableValue ?? value.type;
}

async function main() {
  const targets = await getJson("/json");
  const target = targets.find((item) => item.type === "page" && item.url?.startsWith("app://obsidian.md/") && item.webSocketDebuggerUrl)
    ?? targets.find((item) => item.type === "page" && item.title !== "DevTools" && item.webSocketDebuggerUrl)
    ?? targets.find((item) => item.webSocketDebuggerUrl);
  if (!target) throw new Error("No Obsidian debugger target found");

  console.log(`Capturing ${target.title || target.url} for ${CAPTURE_MS / 1000} seconds`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  socket.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
  socket.send(JSON.stringify({ id: 2, method: "Log.enable" }));
  socket.send(JSON.stringify({ id: 3, method: "Network.enable" }));
  socket.send(JSON.stringify({
    id: 10,
    method: "Runtime.evaluate",
    params: {
      expression: `JSON.stringify({ vaultPath: app.vault.adapter.getBasePath?.(), configDir: app.vault.configDir, pluginDir: app.plugins.plugins["obsidian-sync-engine"]?.manifest.dir })`,
      returnByValue: true,
    },
  }));

  const requests = new Map();
  let errorCount = 0;

  socket.on("message", (message) => {
    const event = JSON.parse(String(message));
    if (event.id === 10) {
      console.log("[context]", event.result?.result?.value ?? event.result?.exceptionDetails?.text ?? "unavailable");
    } else if (event.method === "Runtime.consoleAPICalled") {
      const { type, args } = event.params;
      if (type === "error") errorCount += 1;
      console.log(`[console.${type}]`, args.map(remoteValue).join(" "));
    } else if (event.method === "Runtime.exceptionThrown") {
      errorCount += 1;
      const detail = event.params.exceptionDetails;
      console.error("[exception]", detail.exception?.description ?? detail.text);
    } else if (event.method === "Log.entryAdded") {
      const entry = event.params.entry;
      if (entry.level === "error") errorCount += 1;
      console.log(`[log.${entry.level}]`, entry.text, entry.url ? `(${entry.url}:${entry.lineNumber})` : "");
    } else if (event.method === "Network.requestWillBeSent") {
      requests.set(event.params.requestId, event.params.request);
    } else if (event.method === "Network.loadingFailed") {
      errorCount += 1;
      const request = requests.get(event.params.requestId);
      console.error("[network.failed]", request ? `${request.method} ${request.url}` : event.params.requestId, event.params.errorText);
    } else if (event.method === "Network.responseReceived" && event.params.response.status >= 400) {
      errorCount += 1;
      const response = event.params.response;
      console.error("[network.response]", response.status, response.url);
    }
  });

  await new Promise((resolve) => setTimeout(resolve, CAPTURE_MS));
  socket.close();
  if (errorCount > 0) {
    console.error(`Capture complete with ${errorCount} error(s)`);
    process.exitCode = 1;
  } else {
    console.log("Capture complete: no errors");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
