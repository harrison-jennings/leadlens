import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");
const minify = process.argv.includes("--minify");

/**
 * Some dependencies ship an ESM build that calls `createRequire(import.meta.url)`
 * to load its own data files. Bundled into CommonJS, `import.meta.url` is
 * undefined and the module throws on load — which takes the whole extension
 * with it, before `activate()` is ever called.
 *
 * esbuild picks a package's `import` or `require` entry from the *importing*
 * file's module type, and the engine is ESM, so its dependencies resolve to
 * their ESM builds. `require.resolve` here picks the `require` entry instead,
 * which for these packages is a plain CommonJS build with no such trick in it.
 *
 * Found by an integration test: the extension loaded fine in unit tests, which
 * import the sources directly, and failed to load at all in a real editor.
 */
const PREFER_COMMONJS = ["css-tree"];

const preferCommonJs = {
  name: "prefer-commonjs",
  setup(build) {
    for (const name of PREFER_COMMONJS) {
      build.onResolve({ filter: new RegExp(`^${name}$`) }, (args) => {
        // Resolve from whoever imported it: these are the engine's
        // dependencies, and in a linked checkout they live beside the engine
        // rather than beside this extension.
        const from = createRequire(args.importer);
        return { path: from.resolve(name) };
      });
    }
  },
};

/**
 * Markers for the VS Code watch task.
 *
 * `.vscode/tasks.json` has to know when a rebuild starts and finishes, so that
 * pressing F5 waits for the bundle instead of launching the previous one.
 * esbuild's own watch logging is not a stable contract — these strings are
 * ours, so the problem matcher cannot break under us when esbuild changes its
 * wording.
 */
const watchMarkers = {
  name: "watch-markers",
  setup(build) {
    build.onStart(() => console.log("[watch] build started"));
    build.onEnd((result) => {
      for (const error of result.errors) {
        const at = error.location;
        // The shape the matcher parses: file:line:col: error: message.
        if (at) console.log(`${at.file}:${at.line}:${at.column}: error: ${error.text}`);
        else console.log(`build.mjs:1:1: error: ${error.text}`);
      }
      console.log("[watch] build finished");
    });
  },
};

const options = {
  entryPoints: ["src/extension.ts"],
  outfile: "out/extension.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["vscode"],
  plugins: watch ? [preferCommonJs, watchMarkers] : [preferCommonJs],
  sourcemap: watch,
  minify,
  logLevel: "info",
};

/**
 * Every package bundled into out/extension.js, with its licence text.
 *
 * Several bundled licences (BSD in particular) require their notice to travel
 * with any redistributed copy, and the VSIX is one. The list comes from
 * esbuild's own record of what it bundled, so an engine update that adds or
 * drops a dependency changes the notices in the same build.
 */
const LICENCE_FILES = /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i;

// Data rather than a package: the engine's compatibility tables derive from
// caniemail.com, whose repository is MIT licensed.
const CANIEMAIL = {
  name: "caniemail (compatibility data, via @emailens/engine)",
  licence: "MIT",
  text: `MIT License

Copyright (c) 2019 Rémi Parmentier

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
};

// Packages published without a licence file. Their notice is the standard
// text of the licence they declare, with the author named in their manifest.
// Anything else missing a file stops the build rather than ship without one.
const LICENCE_TEXT_BY_PACKAGE = {
  boolbase: `ISC License

Copyright (c) Felix Boehm <me@feedic.com>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
};

function writeNotices(metafile) {
  const roots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const at = input.lastIndexOf("node_modules/");
    if (at === -1) continue;
    const rest = input.slice(at + "node_modules/".length).split("/");
    const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
    roots.add(input.slice(0, at + "node_modules/".length) + name);
  }

  const entries = [...roots].map((root) => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const file = readdirSync(root).find((name) => LICENCE_FILES.test(name));
    const text = file
      ? readFileSync(join(root, file), "utf8").trim()
      : LICENCE_TEXT_BY_PACKAGE[manifest.name];
    if (!text) throw new Error(`${manifest.name} ships no licence file; add its notice to build.mjs.`);
    return { name: `${manifest.name} ${manifest.version}`, licence: manifest.license ?? "see text", text };
  });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  entries.push(CANIEMAIL);

  const sections = entries.map(({ name, licence, text }) =>
    `## ${name}\n\nLicence: ${licence}\n\n\`\`\`text\n${text}\n\`\`\``);
  writeFileSync(
    "THIRD_PARTY_NOTICES.md",
    "# Third-party notices\n\n" +
      "Leadlens includes the following third-party software and data. Each is used under the licence reproduced below.\n\n" +
      sections.join("\n\n") + "\n",
  );
  console.log(`THIRD_PARTY_NOTICES.md: ${entries.length} entries`);
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  const result = await build({ ...options, metafile: true });
  writeNotices(result.metafile);
}
