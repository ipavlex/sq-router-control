/**
 * SQ Router Control — webpack build.
 * Three independent targets:
 *   main     → Electron main process   → dist/main/main.js
 *   preload  → preload bridge          → dist/main/preload.js
 *   renderer → browser bundle          → dist/renderer/renderer.js
 *             (+ copies index.html + styles.css next to it)
 */
const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");
const HtmlFromTabsPlugin = require("./webpack/html-from-tabs-plugin");

const common = {
  resolve: {
    extensions: [".ts", ".js"],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: {
          loader: "ts-loader",
          options: {
            transpileOnly: true,
          },
        },
      },
    ],
  },
  devtool: "source-map",
  stats: "errors-warnings",
};

module.exports = [
  {
    ...common,
    name: "main",
    target: "electron-main",
    entry: "./src/main/main.ts",
    output: {
      path: path.resolve(__dirname, "dist/main"),
      filename: "main.js",
    },
    plugins: [
      // Ship the app icon next to main.js so the Dock/window icon can be set
      // at runtime in dev mode (the packaged app embeds it via
      // electron-builder, which also picks up build/icon.icns for macOS).
      new CopyPlugin({
        patterns: [
          { from: "build/icon.png", to: "icon.png" },
        ],
      }),
    ],
  },
  {
    ...common,
    name: "preload",
    target: "electron-preload",
    entry: "./src/main/preload.ts",
    output: {
      path: path.resolve(__dirname, "dist/main"),
      filename: "preload.js",
    },
  },
  {
    ...common,
    name: "renderer",
    target: "web",
    entry: "./src/renderer/index.ts",
    output: {
      path: path.resolve(__dirname, "dist/renderer"),
      filename: "renderer.js",
    },
    plugins: [
      new HtmlFromTabsPlugin({
        template: path.resolve(__dirname, "src/renderer/assets/index.template.html"),
        fragments: [
          { name: "connect", file: path.resolve(__dirname, "src/renderer/connect/view.html") },
          { name: "dashboard", file: path.resolve(__dirname, "src/renderer/dashboard/view.html") },
          { name: "routing", file: path.resolve(__dirname, "src/renderer/tabs/routing/view.html") },
          { name: "log", file: path.resolve(__dirname, "src/renderer/tabs/log/view.html") },
          { name: "monitor", file: path.resolve(__dirname, "src/renderer/tabs/monitor/view.html") },
          { name: "routing-modals", file: path.resolve(__dirname, "src/renderer/tabs/routing/modals.html") },
        ],
        output: "index.html",
      }),
      new CopyPlugin({
        patterns: [
          { from: "src/renderer/assets/styles.css", to: "styles.css" },
        ],
      }),
    ],
  },
];
