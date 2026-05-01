import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import fs from "fs";

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
  plugins: [fixTikzjaxPaths],
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
