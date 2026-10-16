const path = require('node:path');
const { CopyRspackPlugin } = require('@rspack/core');
const { lib } = require('@alexneamtu/serverless-rspack');

module.exports = {
  entry: lib.entries,
  mode: lib.webpack.isLocal ? 'development' : 'production',
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        loader: 'builtin:swc-loader',
        options: { jsc: { parser: { syntax: 'typescript' }, target: 'es2022' } },
      },
    ],
  },
  // Files read at runtime must be copied into each function's output.
  plugins: [new CopyRspackPlugin({ patterns: [{ from: 'assets', to: 'assets' }] })],
  cache: {
    type: 'persistent',
    storage: { type: 'filesystem', directory: path.join(__dirname, '.rspack-cache') },
  },
};
