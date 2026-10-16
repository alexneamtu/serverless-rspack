'use strict';

const { isBuiltin } = require('node:module');
const path = require('node:path');
const v8 = require('node:v8');
const vm = require('node:vm');
const { rspack } = require('@rspack/core');

// serverless-webpack's watch code calls require('webpack'); point it at Rspack's compatible API.
// shortcut: anything else resolving the same webpack path also gets Rspack; copy wpwatch/run if that bites.
const webpackPath = require.resolve('webpack', { paths: [path.dirname(require.resolve('serverless-webpack'))] });
require.cache[webpackPath] = { id: webpackPath, filename: webpackPath, loaded: true, exports: rspack };
const ServerlessWebpack = require('serverless-webpack');

// Library types whose .js output Lambda's require() can load.
const COMMONJS_LIBRARY_TYPES = new Set(['commonjs', 'commonjs2', 'commonjs-module', 'commonjs-static']);

// Rspack frees a compiler's native memory, including its loaded persistent cache, only when V8
// collects the JS object. V8 cannot see that memory, so without a forced collection every function
// keeps its cache resident (5 GB for 20 functions in bench/run.js) and later steps slow down.
// shortcut: process-wide GC flag; drop it once Rspack releases native memory on close().
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

// Returns plain data, not stats: stats reference the compiler and would keep it alive.
const build = (config) => {
  const compiler = rspack(config);
  return new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      // Flush the persistent cache and release native compiler resources before
      // starting the next function, including when compilation fails.
      compiler.close((closeError) => {
        if (error || closeError) return reject(error || closeError);
        if (!stats) return reject(new Error('Rspack returned no build result'));
        return resolve({
          // Package names of non-built-in externals: 'external commonjs "@scope/pkg/sub"' -> '@scope/pkg'.
          externals: [...new Set(stats.toJson({ all: false, modules: true }).modules.flatMap(({ identifier }) => {
            const request = /^external .*"(.*)"$/.exec(identifier)?.[1];
            return request && !isBuiltin(request) ? [request.split('/').slice(0, request.startsWith('@') ? 2 : 1).join('/')] : [];
          }))],
          errors: stats.hasErrors() && stats.toString({ all: false, errors: true }),
          warnings: stats.hasWarnings() && stats.toString({ all: false, warnings: true }),
        });
      });
    });
  });
};

// Reuses serverless-webpack's entry discovery, ZIP packaging and artifact hooks.
// Only compilation changes.
class ServerlessRspack extends ServerlessWebpack {
  constructor(...args) {
    super(...args);
    const fail = (message) => {
      throw new this.serverless.classes.Error(message);
    };
    const toRspack = (original) => {
      // serverless-webpack defaults to output.libraryTarget, which Rspack 2 ignores, leaving
      // bundles without exports. Rspack only honours output.library.type.
      const { libraryTarget, ...output } = original.output;
      // commonjs-static also exposes named exports to import(), which Serverless v4 invoke local uses.
      const type = output.library?.type ?? (!libraryTarget || libraryTarget === 'commonjs' ? 'commonjs-static' : libraryTarget);
      if (type === 'module') {
        // Lambda loads .js as CommonJS unless a package.json says otherwise; .mjs is always ESM.
        if (!String(output.filename).endsWith('.mjs')) fail('serverless-rspack: ESM output needs output.filename ending in .mjs.');
      } else if (!COMMONJS_LIBRARY_TYPES.has(type)) {
        fail(`serverless-rspack: output.library.type "${type}" is unsupported; use a CommonJS type or "module".`);
      }
      const config = { ...original, output: { ...output, library: { ...output.library, type } } };
      if (config.cache?.type === 'persistent') config.cache = { ...config.cache, name: path.basename(output.path) };
      return config;
    };
    const normalize = () => {
      this.webpackConfig = Array.isArray(this.webpackConfig) ? this.webpackConfig.map(toRspack) : toRspack(this.webpackConfig);
    };
    // The parent assigns its methods on the instance, so override after super().
    this.compile = async () => {
      normalize();
      this.compileStats = { stats: [] };
      const configs = [].concat(this.webpackConfig);
      for (const [index, config] of configs.entries()) {
        this.serverless.cli.log(`Rspack: compiling ${path.basename(config.output.path)} (${index + 1}/${configs.length})`);
        const { externals, errors, warnings } = await build(config).finally(gc);
        if (errors) fail(errors);
        if (warnings) this.serverless.cli.log(warnings);
        this.compileStats.stats.push({ outputPath: config.output.path, externalModules: externals.map((external) => ({ external })) });
      }
      if (this.progress) this.progress.get('webpack').remove();
    };
    // wpwatch serves offline; watch serves invoke local --watch.
    for (const name of ['wpwatch', 'watch']) {
      const parent = this[name];
      this[name] = (...args) => {
        normalize();
        return parent.apply(this, args);
      };
    }
  }
}

module.exports = ServerlessRspack;
