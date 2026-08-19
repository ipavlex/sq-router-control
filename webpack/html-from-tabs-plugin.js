/**
 * HtmlFromTabsPlugin — assembles dist/renderer/index.html from
 * src/renderer/index.template.html plus per-module HTML fragments.
 *
 * The template contains placeholders of the form `<!-- @tab:NAME -->`.
 * Each configured fragment is read from disk and substituted in place of
 * its placeholder, so every module owns its markup next to its code.
 * Substitution is multi-pass: fragments may themselves contain placeholders
 * (e.g. the dashboard fragment embeds the tab placeholders).
 */
const fs = require("fs");
const path = require("path");

class HtmlFromTabsPlugin {
  /**
   * @param {object} options
   * @param {string} options.template  path to index.template.html
   * @param {Array<{name: string, file: string}>} options.fragments
   *   name = placeholder suffix (`@tab:NAME`), file = path to the fragment
   * @param {string} options.output    output filename (default "index.html")
   */
  constructor(options) {
    this.template = options.template;
    this.fragments = options.fragments;
    this.output = options.output || "index.html";
  }

  apply(compiler) {
    compiler.hooks.thisCompilation.tap("HtmlFromTabsPlugin", (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: "HtmlFromTabsPlugin",
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONS,
        },
        () => {
          let html = fs.readFileSync(this.template, "utf8");
          const byName = new Map(
            this.fragments.map((f) => [f.name, f.file])
          );
          // Multi-pass: a fragment may reference other placeholders, so keep
          // substituting until no placeholder remains (or we stop making
          // progress).
          let changed = true;
          while (changed) {
            changed = false;
            for (const [name, file] of byName) {
              const placeholder = `<!-- @tab:${name} -->`;
              if (html.includes(placeholder)) {
                html = html.replace(placeholder, fs.readFileSync(file, "utf8"));
                changed = true;
              }
            }
          }
          const leftover = html.match(/<!-- @tab:[a-z-]+ -->/g);
          if (leftover) {
            compilation.errors.push(
              new Error(
                `HtmlFromTabsPlugin: unresolved placeholder(s) ${leftover.join(", ")} in ${this.template}`
              )
            );
          }
          compilation.emitAsset(
            this.output,
            new compiler.webpack.sources.RawSource(html)
          );
        }
      );
    });
  }
}

module.exports = HtmlFromTabsPlugin;