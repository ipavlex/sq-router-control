/**
 * HtmlFromTabsPlugin — assembles dist/renderer/index.html from
 * src/renderer/index.template.html plus per-tab HTML fragments.
 *
 * The template contains placeholders of the form `<!-- @tab:NAME -->`.
 * Each configured fragment is read from disk and substituted in place of
 * its placeholder, so every tab owns its markup next to its code.
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
          for (const frag of this.fragments) {
            const content = fs.readFileSync(frag.file, "utf8");
            const placeholder = `<!-- @tab:${frag.name} -->`;
            if (!html.includes(placeholder)) {
              compilation.errors.push(
                new Error(
                  `HtmlFromTabsPlugin: placeholder "${placeholder}" not found in ${this.template}`
                )
              );
              continue;
            }
            html = html.replace(placeholder, content);
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