import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "module";
import fs from "fs";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);

const prod = process.argv[2] === "production";

// Patch node-tikzjax bootstrap.js:
// 1. Fix __dirname path: bundle's __dirname points to plugin root, but bootstrap
//    uses '../tex' relative to its own dist/ folder. Rewrite to 'tex'.
// 2. Cache the compiled WebAssembly module: bootstrap.js calls
//    WebAssembly.instantiate(bytecode, ...) on every render, which includes a
//    slow compilation step (~2-5s). Cache the compiled Module so subsequent
//    renders only do instantiation (fast).
const fixTikzjaxPaths = {
  name: "fix-tikzjax-paths",
  setup(build) {
    build.onLoad(
      { filter: /node-tikzjax\/dist\/bootstrap\.js$/ },
      async (args) => {
        let src = await fs.promises.readFile(args.path, "utf8");
        // Fix 1: tex path.
        // __dirname in Electron's renderer may resolve to the Electron binary directory
        // rather than the plugin root. We let main.ts set globalThis.__MARP_TIKZ_TEX_DIR
        // to the verified correct path; fall back to __dirname-relative 'tex' otherwise.
        src = src.replace(
          /const TEX_DIR = \(0,\s*path_1\.join\)\s*\(\s*__dirname\s*,\s*['"]\.\.\/tex['"]\s*\)\s*;/,
          "const TEX_DIR = (typeof globalThis.__MARP_TIKZ_TEX_DIR === 'string' && globalThis.__MARP_TIKZ_TEX_DIR) || (0, path_1.join)(__dirname, 'tex'); console.log('[MarpTikz-boot] TEX_DIR:', TEX_DIR);"
        );
        // Fix 3: replace async stream loading with synchronous readFileSync+gunzipSync.
        // The original pipe()-based approach silently hangs in Electron's renderer process
        // when createReadStream emits an error — Node.js pipe() does not forward source
        // stream errors to the destination, so stream2buffer's Promise never resolves.
        // readFileSync+gunzipSync avoid streams entirely and throw clearly on failure.
        src = src.replace(
          /if \(!coredump\) \{\s*const stream = \(0, fs_1\.createReadStream\)\(COREDUMP_PATH\)\.pipe\(\(0, zlib_1\.createGunzip\)\(\)\);\s*coredump = await stream2buffer\(stream\);\s*\}/,
          `if (!coredump) { coredump = zlib_1.gunzipSync(fs_1.readFileSync(COREDUMP_PATH)); }`
        );
        src = src.replace(
          /if \(!bytecode\) \{\s*const stream = \(0, fs_1\.createReadStream\)\(BYTECODE_PATH\)\.pipe\(\(0, zlib_1\.createGunzip\)\(\)\);\s*bytecode = await stream2buffer\(stream\);\s*\}/,
          `if (!bytecode) { bytecode = zlib_1.gunzipSync(fs_1.readFileSync(BYTECODE_PATH)); }`
        );
        // Fix 4: add error forwarding in extractTexFilesToMemory — same pipe() issue.
        // Replace the stream chain + await Promise block with one that forwards errors.
        src = src.replace(
          /const stream = \(0, fs_1\.createReadStream\)\(TEX_FILES_PATH\)\.pipe\(\(0, zlib_1\.createGunzip\)\(\)\)\.pipe\(\(0, tar_fs_1\.extract\)\(TEX_FILES_EXTRACTED_PATH,\s*\{[\s\S]*?\}\)\);[\s\S]*?await new Promise\(\(resolve, reject\) => \{[\s\S]*?stream\.on\(["']finish["'], resolve\);[\s\S]*?stream\.on\(["']error["'], reject\);[\s\S]*?\}\);/,
          `await new Promise((resolve, reject) => {
        const _src = (0, fs_1.createReadStream)(TEX_FILES_PATH);
        const _gz = (0, zlib_1.createGunzip)();
        const _tar = (0, tar_fs_1.extract)(TEX_FILES_EXTRACTED_PATH, { fs });
        _src.on('error', reject); _gz.on('error', reject);
        _tar.on('finish', resolve); _tar.on('error', reject);
        _src.pipe(_gz).pipe(_tar);
    });`
        );
        // Fix 2: cache compiled WASM module to avoid recompilation on every render.
        // IMPORTANT: WebAssembly.instantiate(bytes, imports) returns { module, instance }
        //            WebAssembly.instantiate(Module, imports) returns Instance only.
        // We must preserve the { module, instance } shape the caller expects.
        src = src.replace(
          /const wasm = await WebAssembly\.instantiate\(bytecode,\s*\{\s*library:\s*library,\s*env:\s*\{\s*memory:\s*memory\s*\},?\s*\}\s*\);/,
          `if (!exports.__cachedWasmModule) {
    exports.__cachedWasmModule = await WebAssembly.compile(bytecode);
}
const wasm = {
    module: exports.__cachedWasmModule,
    instance: await WebAssembly.instantiate(exports.__cachedWasmModule, { library: library, env: { memory: memory } }),
};`
        );
        return { contents: src, loader: "js" };
      }
    );
  },
};

// Patch require("punycode/") — tr46/tough-cookie use this pattern to explicitly
// target the npm punycode package rather than the deprecated Node built-in.
// esbuild leaves it as an external require, which fails at runtime in Electron
// because "punycode/" (trailing slash) isn't a valid built-in specifier.
// Intercept and resolve to the npm package file so esbuild bundles it.
const PUNYCODE_PATH = _require.resolve("punycode/punycode.js");

const fixPunycode = {
  name: "fix-punycode",
  setup(build) {
    build.onResolve({ filter: /^punycode\/$/ }, () => ({
      path: PUNYCODE_PATH,
    }));
  },
};

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
    ...builtinModules.map(m => `node:${m}`),
  ],
  plugins: [fixTikzjaxPaths, fixPunycode],
  platform: "node",
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
