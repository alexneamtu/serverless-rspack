<p align="center">
  <img src="https://raw.githubusercontent.com/alexneamtu/serverless-rspack/main/.github/hero.svg" alt="serverless-rspack: compile Lambda functions with Rspack. Cold per-function packaging of 20 functions: webpack 34.6 s, Rspack 9.0 s." width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@alexneamtu/serverless-rspack"><img src="https://img.shields.io/npm/v/@alexneamtu/serverless-rspack?color=ff8a3d" alt="npm version"></a>
  <a href="https://github.com/alexneamtu/serverless-rspack/actions/workflows/ci.yml"><img src="https://github.com/alexneamtu/serverless-rspack/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@alexneamtu/serverless-rspack" alt="MIT license"></a>
  <img src="https://img.shields.io/node/v/@alexneamtu/serverless-rspack" alt="Node.js version">
</p>

# @alexneamtu/serverless-rspack

A Serverless Framework plugin that compiles Node.js Lambda functions with [Rspack](https://rspack.rs) 2.

It extends [serverless-webpack](https://github.com/serverless-heaven/serverless-webpack) and replaces only the compile step. Entry discovery, per-function or per-service ZIPs, and the deploy hooks are serverless-webpack's.

## Install

```sh
npm install --save-dev @alexneamtu/serverless-rspack @rspack/core
```

npm also installs serverless-webpack's peer dependencies (`webpack`, `serverless`). This plugin never runs webpack, but serverless-webpack loads it. If you use [osls](https://github.com/oss-serverless/osls), install it under the `serverless` alias (`npm install --save-dev serverless@npm:osls`). That satisfies the peer, so npm does not add Serverless Framework v4.

## Configure

`serverless.yml`:

```yaml
plugins:
  - '@alexneamtu/serverless-rspack'

custom:
  webpack:
    webpackConfig: rspack.config.js
    includeModules: false # required
```

`rspack.config.js`:

```js
const { lib } = require('@alexneamtu/serverless-rspack');

module.exports = {
  entry: lib.entries,
  mode: 'production',
};
```

`lib` is serverless-webpack's `slsw.lib`: `lib.entries` lists the function handlers and `lib.webpack.isLocal` reports local invocation.

The plugin sets `output.library.type` to `commonjs-static` when it is unset, so handlers load with both `require()` and `import()` (Serverless v4 `invoke local` uses `import()`). A legacy `output.libraryTarget` is converted to `output.library.type`, with `commonjs` becoming `commonjs-static`. If you set `output` yourself, include `path` and `filename`, because serverless-webpack only fills in its defaults when `output` is missing.

Complete examples:

- [`examples/javascript`](examples/javascript): the minimal config above, packaged as a single service ZIP.
- [`examples/typescript`](examples/typescript): `builtin:swc-loader`, per-function ZIPs, an asset copied with `CopyRspackPlugin`, and a persistent cache.

Run `serverless package` or `serverless deploy` as usual. `serverless invoke local` works too.

## Supported

Every cell below runs the full test suite against the packed npm tarball installed in a clean project.

| | Tested versions |
| --- | --- |
| Node.js (build) | 22, 24, 26 (26 run locally only, not in CI) |
| Framework | osls 3.78.0, osls 4.4.0, Serverless Framework 3.40.0, Serverless Framework 4.44.0 (run locally only, not in CI) |
| `@rspack/core` | 2.0.0, 2.2.9 |
| serverless-webpack | 5.16.2 (pinned; the plugin depends on its internals) |
| Lambda runtime | `nodejs22.x`, `nodejs24.x`: handlers from the extracted ZIPs are invoked in the AWS Lambda base images |

The suite covers:

- JavaScript and TypeScript handlers
- per-function and single-service packaging
- copied assets
- fresh output after source and asset changes with a warm persistent cache
- compilation errors failing the command
- `invoke local --watch` recompiling after a source change
- `serverless offline` serving a compiled handler (serverless-offline 13 with Serverless Framework 3, 14 with osls)
- rejection of unsupported options

Serverless Framework v4 is not in CI because it needs a Serverless access key and real AWS credentials, even for `serverless package`.

## Not supported

These fail with an error instead of producing a broken package:

- `includeModules` other than `false`. External `node_modules` are not packaged, so bundle every dependency. `externals` are not packaged either; use them only for modules the runtime already provides.
- `output.library.type` values that are not CommonJS (`commonjs`, `commonjs2`, `commonjs-module`, `commonjs-static`). ESM handlers are not supported.

Other limitations:

- Functions compile one at a time. serverless-webpack's `concurrency` setting is ignored. Watch mode (`serverless offline`, `--watch`) builds all functions together, like serverless-webpack.
- `run --watch` is untested.
- The Rspack config is the only build config. Webpack-only plugins and loaders may not work under Rspack.
- After each function the plugin runs a full garbage collection, using Node's `--expose-gc` flag for the whole process. Without it, Rspack keeps every function's persistent cache in memory (5 GB for the 20-function benchmark).
- Other runtimes, other providers, Yarn PnP and pnpm are untested.

## Benchmark

`node bench/run.js [runs] [functions]` packages one generated TypeScript service with serverless-webpack (webpack 5.112 with `swc-loader`) and with this plugin (`builtin:swc-loader`). Both use the same settings: no minification, a filesystem cache, and AWS SDK v3, zod and date-fns bundled into every function.

The table shows the median wall time of `serverless package` in seconds. Cold runs start with an empty cache; warm runs repeat right after.

20 functions, 5 interleaved runs; Node 26.7, osls 3.78, Rspack 2.2.9; Intel i5-7360U, 4 threads.

| Packaging | Bundler | Cold cache | Warm cache |
| --- | --- | ---: | ---: |
| per function | webpack | 34.6 | 11.8 |
| per function | rspack | 9.0 | 12.2 |
| service | webpack | 8.8 | 4.3 |
| service | rspack | 3.4 | 3.7 |

Cold builds are where Rspack is faster. In this fixture, Rspack's persistent cache does not shorten warm per-function builds. Run the script on your own service before relying on these numbers.

## License

[MIT](LICENSE). serverless-webpack, a runtime dependency, is MIT-licensed by Nicola Peduzzi and Frank Schmid. This package contains none of its code.
