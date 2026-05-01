import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import fs from "fs";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);

const prod = process.argv[2] === "production";

// Patch node-tikzjax bootstrap.js: __dirname in the bundle points to the
// plugin root (where main.js lives). The original uses '../tex' (relative to
// its own dist/ folder), but after bundling that resolves incorrectly.
// We copy tex/ into the plugin root and rewrite the path to 'tex'.
const fixTikzjaxPaths = {
  name: "fix-tikzjax-paths",
  setup(build) {
    build.onLoad(
      { filter: /node-tikzjax\/dist\/bootstrap\.js$/ },
      async (args) => {
        let src = await fs.promises.readFile(args.path, "utf8");
        // Change path.join(__dirname, '../tex') → path.join(__dirname, 'tex')
        src = src.replace(
          /\(0,\s*path_1\.join\)\s*\(\s*__dirname\s*,\s*'\.\.\/tex'\s*\)/,
          "(0, path_1.join)(__dirname, 'tex')"
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
    ...builtins,
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
