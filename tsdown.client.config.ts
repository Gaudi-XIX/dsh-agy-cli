export default [
  {
    entry: { client: "client/index.ts" },
    outDir: "dist",
    format: ["cjs"],
    platform: "browser",
    target: "es2024",
    dts: false,
    clean: false,
    fixedExtension: false,
    external: [/^@deepseek-ai\//, "react", "react-dom", "react/jsx-runtime"],
    outputOptions: {
      entryFileNames: "client.js",
      banner: `window.__ModuleLoader__.load({ id: "dsh-agy-provider", factory: (require) => {`,
      intro: "var module = { exports: {} }; var exports = module.exports;",
      footer: "return module.exports; } });",
    },
  },
];
