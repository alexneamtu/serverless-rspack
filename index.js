'use strict';

const path = require('node:path');
const v8 = require('node:v8');
const vm = require('node:vm');
const { rspack } = require('@rspack/core');
const ServerlessWebpack = require('serverless-webpack');

// Lambda loads .js handlers with require(), so only CommonJS library types expose them.
const COMMONJS_LIBRARY_TYPES = new Set(['commonjs', 'commonjs2', 'commonjs-module', 'commonjs-static']);

// Rspack frees a compiler's native memory, including its loaded persistent cache, only when V8
// collects the JS object. V8 cannot see that memory, so without a forced collection every function
// keeps its cache resident (5 GB for 20 functions in bench/run.js) and later steps slow down.
// shortcut: process-wide GC flag; drop it once Rspack releases native memory on close().
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

// Returns messages, not stats: stats reference the compiler and would keep it alive.
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
          errors: stats.hasErrors() && stats.toString({ all: false, errors: true }),
          warnings: stats.hasWarnings() && stats.toString({ all: false, warnings: true }),
        });
      });
    });
  });
};

// Reuses serverless-webpack's entry discovery, ZIP packaging and artifact hooks.
// Only compilation changes; dependencies must be bundled (includeModules: false).
class ServerlessRspack extends ServerlessWebpack {
  constructor(...args) {
    super(...args);
    const fail = (message) => {
      throw new this.serverless.classes.Error(message);
    };
    // The parent assigns its methods on the instance, so override after super().
    this.compile = async () => {
      if (this.configuration.includeModules) {
        fail('serverless-rspack requires custom.webpack.includeModules: false; bundle dependencies instead.');
      }
      this.compileStats = { stats: [] };
      const configs = [].concat(this.webpackConfig);
      for (const [index, original] of configs.entries()) {
        // serverless-webpack defaults to output.libraryTarget, which Rspack 2 ignores, leaving
        // bundles without exports. Rspack only honours output.library.type.
        const { libraryTarget, ...output } = original.output;
        const type = output.library?.type ?? libraryTarget ?? 'commonjs';
        if (!COMMONJS_LIBRARY_TYPES.has(type)) {
          fail(`serverless-rspack: output.library.type "${type}" is unsupported; Lambda handlers need a CommonJS type.`);
        }
        const name = path.basename(output.path);
        const config = { ...original, output: { ...output, library: { ...output.library, type } } };
        if (config.cache?.type === 'persistent') config.cache = { ...config.cache, name };
        this.serverless.cli.log(`Rspack: compiling ${name} (${index + 1}/${configs.length})`);
        const { errors, warnings } = await build(config).finally(gc);
        if (errors) fail(errors);
        if (warnings) this.serverless.cli.log(warnings);
        this.compileStats.stats.push({ outputPath: output.path, externalModules: [] });
      }
      if (this.progress) this.progress.get('webpack').remove();
    };
    // wpwatch serves offline/--watch; watch serves invoke local --watch and run --watch.
    // Both would call webpack directly.
    this.wpwatch = this.watch = () => fail('serverless-rspack does not support watch mode.');
  }
}

module.exports = ServerlessRspack;
