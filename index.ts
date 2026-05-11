#!/usr/bin/env bun

import { reload, withHtmlLiveReload } from "./liveReload";
import { existsSync, readFileSync, watch } from "node:fs";
import { networkInterfaces } from "node:os";
import path, { basename, dirname, extname, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import escapeHtml from "escape-html";
import pc from "picocolors";
import pkg from "./package.json";

const DEFAULT_PORT = 49322;
const DEFAULT_P5JS_VERSION = "1.11.13";
const SCRIPT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
]);
const WATCH_IGNORES = new Set([".git", "node_modules", ".DS_Store"]);

type CliOptions = {
  entry: string;
  port: number;
  host: string;
  p5JsVersion: string;
  open: boolean;
};

let currentBuild = "";
let currentMode: "classic" | "module" = "module";
let buildError: string | null = null;
let buildTimer: Timer | null = null;

async function main() {
  const startTime = Date.now();

  const options = parseCliArgs(Bun.argv.slice(2));
  const entry = resolve(options.entry);
  const root = dirname(entry);

  if (!existsSync(entry)) {
    fail(`Input file does not exist: ${entry}`);
  }

  if (!SCRIPT_EXTENSIONS.has(extname(entry))) {
    fail("Input file must be a JavaScript or TypeScript file.");
  }

  await rebuild(entry, false);

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    idleTimeout: 0,
    fetch: withHtmlLiveReload(async (request) => {
      const url = new URL(request.url);

      if (url.pathname === "/p5run-state.json") {
        return jsonResponse({
          error: buildError,
          mode: currentMode,
        });
      }

      if (url.pathname === "/sketch.js") {
        if (buildError) {
          return jsResponse(`throw new Error(${JSON.stringify(buildError)});`);
        }
        return jsResponse(currentBuild);
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return htmlResponse(
          renderHtml(basename(entry), currentMode, options.p5JsVersion),
        );
      }

      return serveStaticFile(root, url.pathname);
    }),
  });

  try {
    const watcher = watch(
      root,
      { persistent: true, recursive: true },
      (_event, changedName) => {
        if (!changedName) return;
        if (!shouldRebuildForChange(changedName.toString())) return;
        scheduleRebuild(entry);
      },
    );
    watcher.on("error", (error) => {
      log("error", `Watch failed: ${errorMessage(error)}`);
    });
  } catch (error) {
    fail(`Watch failed: ${errorMessage(error)}`);
  }

  const elapsed = (Date.now() - startTime).toFixed(2);
  const port = server.port ?? options.port;
  const localHost = isAnyHost(options.host) ? "localhost" : options.host;
  const localUrl = `http://${formatHostForUrl(localHost)}:${port}/`;

  console.log();
  console.log(
    pc.green(pc.bold(`p5run ${pkg.version}`)) + pc.dim("  ready in ") +
      pc.bold(pc.white(elapsed)) + pc.gray(" ms"),
  );
  console.log(pc.bold(" p5.js:   ") + pc.dim(`v${options.p5JsVersion}`));
  console.log(pc.bold(" local:   ") + pc.dim(localUrl));
  for (const url of getNetworkUrls(options.host, port)) {
    console.log(pc.bold(" network: ") + pc.dim(`${url}`));
  }
  console.log();

  if (options.open) {
    openBrowser(localUrl);
  }
}

function log(level: "info" | "error", message: string) {
  const now = new Date();
  const time = pc.dim(now.toLocaleTimeString("en-ES", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }));
  const prefix = level === "info"
    ? pc.cyanBright(pc.bold("[p5run]"))
    : pc.redBright(pc.bold("[p5run]"));
  console.log(`${time} ${prefix} ${message}`);
}

function parseCliArgs(args: string[]): CliOptions {
  const parseConfig = {
    args,
    options: {
      help: {
        type: "boolean",
        short: "h",
      },
      open: {
        type: "boolean",
      },
      port: {
        type: "string",
        short: "p",
      },
      host: {
        type: "string",
      },
      "p5js-version": {
        type: "string",
      },
    },
    strict: true,
    allowPositionals: true,
  } as const satisfies ParseArgsConfig;

  try {
    const { values, positionals } = parseArgs(parseConfig);

    if (values.help) {
      printHelp();
      process.exit(0);
    }

    const port = Number(values.port ?? Bun.env.PORT ?? DEFAULT_PORT);
    const host = values.host ?? Bun.env.HOST ?? "localhost";
    const p5JsVersion = values["p5js-version"] ?? Bun.env.P5_VERSION ??
      DEFAULT_P5JS_VERSION;
    const open = values.open ?? false;
    const [entry, ...extraPositionals] = positionals;

    if (extraPositionals.length > 0) {
      fail(`Unexpected argument: ${extraPositionals[0]}`);
    }

    if (!entry) {
      printHelp();
      process.exit(0);
    }

    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      fail("Port must be an integer between 1 and 65535.");
    }

    if (!p5JsVersion.trim()) {
      fail("p5.js version must not be empty.");
    }

    return { entry, port, host, p5JsVersion, open };
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function shouldRebuildForChange(changedName: string) {
  const parts = changedName.split(/[\\/]/);
  if (parts.some((part) => WATCH_IGNORES.has(part))) return false;
  return SCRIPT_EXTENSIONS.has(extname(changedName));
}

function scheduleRebuild(entry: string) {
  if (buildTimer) clearTimeout(buildTimer);
  buildTimer = setTimeout(async () => {
    const success = await rebuild(entry);
    if (success) {
      reload();
      return;
    }
  }, 50);
}

async function rebuild(entry: string, showLog = true): Promise<boolean> {
  const logReloadedMessage = () => {
    if (!showLog) return;
    log(
      "info",
      `${pc.greenBright("reload")}  ${
        pc.dim(path.relative(process.cwd(), entry))
      }`,
    );
  };

  try {
    const source = readFileSync(entry, "utf8");
    const mode = hasModuleSyntax(source) ? "module" : "classic";

    if (mode === "classic") {
      const loader = extname(entry).includes("ts") ? "ts" : "js";
      const transpiler = new Bun.Transpiler({ loader });
      currentBuild = transpiler.transformSync(source);
      currentMode = mode;
      buildError = null;
      logReloadedMessage();
      return true;
    }

    const result = await Bun.build({
      entrypoints: [entry],
      format: "esm",
      target: "browser",
      sourcemap: "inline",
      minify: false,
      external: ["p5", "p5.sound"],
    });

    if (!result.success) {
      throw new Error(result.logs.map((log) => log.message).join("\n"));
    }

    const output = result.outputs[0];
    if (!output) {
      throw new Error("Bun did not produce a sketch bundle.");
    }

    currentBuild = await output.text();
    currentMode = mode;
    buildError = null;
    logReloadedMessage();
    return true;
  } catch (error) {
    buildError = formatBuildError(entry, error);
    log("error", buildError);
    return false;
  }
}

function formatBuildError(entry: string, error: unknown) {
  if (isNodeError(error) && error.code === "ENOENT") {
    return `Input file was not found: ${path.relative(process.cwd(), entry)}`;
  }

  return errorMessage(error);
}

function isNodeError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error &&
    typeof error.code === "string";
}

function hasModuleSyntax(source: string) {
  return /^\s*import(?:\s|[{"'*])/m.test(source) ||
    /^\s*export(?:\s|[{*])/m.test(source) ||
    /^\s*import\s*\(/m.test(source);
}

function htmlResponse(body: string) {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function jsResponse(body: string) {
  return new Response(body, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function serveStaticFile(root: string, pathname: string) {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const relativePath = decodedPath.replace(/^\/+/, "");
  const filePath = resolve(root, relativePath);

  if (!isPathInside(root, filePath) || filePath === root) {
    return new Response("Not found", { status: 404 });
  }

  const file = Bun.file(filePath);
  return file.exists().then((exists) => {
    if (!exists) return new Response("Not found", { status: 404 });

    const headers = new Headers();
    headers.set("cache-control", "no-store");
    if (file.type) headers.set("content-type", file.type);
    return new Response(file, { headers });
  });
}

function isPathInside(root: string, filePath: string) {
  const relative = path.relative(root, filePath);
  return relative !== "" && !relative.startsWith("..") &&
    !path.isAbsolute(relative);
}

function renderHtml(
  title: string,
  initialMode: "classic" | "module",
  p5Version: string,
) {
  const scriptTag = initialMode === "classic"
    ? '<script src="/sketch.js"></script>'
    : `<script type="module">
      await window.p5runBootModule("/sketch.js");
    </script>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} - p5run</title>
    <style>
      html,
      body {
        margin: 0;
        width: 100%;
        min-height: 100%;
        background: #111;
        color: #f8f8f8;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      body {
        overflow: hidden;
      }

      canvas {
        display: block;
      }

    </style>
    <script src="https://cdn.jsdelivr.net/npm/p5@${
    escapeHtml(p5Version)
  }/lib/p5.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/p5@${
    escapeHtml(p5Version)
  }/lib/addons/p5.sound.min.js"></script>
  </head>
  <body>
    <script>
      const readP5runState = async () => {
        return await fetch("/p5run-state.json", { cache: "no-store" }).then((response) => response.json());
      };
      window.p5runBootModule = async (sketchUrl) => {
        const state = await readP5runState();
        if (state.error) {
          console.error(state.error);
          return;
        }

        const mod = await import(sketchUrl);
        const sketch = mod.default ?? mod.sketch;
        if (typeof sketch === "function") {
          new window.p5(sketch);
        }
      };
    </script>
    ${scriptTag}
  </body>
</html>`;
}

function isAnyHost(host: string) {
  return host === "0.0.0.0" || host === "::" || host === "";
}

function formatHostForUrl(host: string) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function getNetworkUrls(host: string, port: number) {
  if (!isAnyHost(host)) return [];

  const urls: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      urls.push(`http://${entry.address}:${port}/`);
    }
  }
  return urls;
}

function openBrowser(url: string) {
  const command = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
    ? ["cmd", "/c", "start", url]
    : ["xdg-open", url];

  Bun.spawn(command, {
    stdout: "ignore",
    stderr: "ignore",
  });
}

function printHelp() {
  console.log(
    `${pc.bold(pc.greenBright("Usage:"))} ${
      pc.cyan(`${pc.bold("p5run")} [options] <sketch.js|sketch.ts>`)
    }

${pc.bold(pc.greenBright("Options:"))}
  ${pc.cyan("-p, --port <port>")}              Port to listen on
  ${pc.cyan("    --host <host>")}              Host to bind
  ${
      pc.cyan("    --p5js-version <version>")
    }   p5.js version to load from jsDelivr
  ${
      pc.cyan("-o, --open")
    }                     Open the preview in the default browser
  ${pc.cyan("-h, --help")}                     Show this help message
`,
  );
}

function fail(message: string): never {
  log("error", message);
  process.exit(1);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

await main();
