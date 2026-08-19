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
    entry: "./src/renderer/renderer.ts",
    output: {
      path: path.resolve(__dirname, "dist/renderer"),
      filename: "renderer.js",
    },
    plugins: [
      new CopyPlugin({
        patterns: [
          { from: "src/renderer/index.html", to: "index.html" },
          { from: "src/renderer/styles.css", to: "styles.css" },
        ],
      }),
    ],
  },
];
