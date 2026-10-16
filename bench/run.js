// Compares `serverless package` wall time for the same generated TypeScript service built by
// serverless-webpack (webpack + swc-loader) and by this plugin (Rspack + builtin:swc-loader).
// Usage: node bench/run.js [runs=5] [functions=20]
const { execFileSync, spawnSync } = require('node:child_process');
const { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runs = Number(process.argv[2] || 5);
const functions = Number(process.argv[3] || 20);
const root = path.resolve(__dirname, '..');
const dependencies = {
  '@rspack/core': '2.2.9', osls: '3.78.0', webpack: '5.112.0', 'serverless-webpack': '5.16.2',
  'swc-loader': '0.2.7', '@swc/core': '1.16.18',
  '@aws-sdk/client-dynamodb': '3.1152.0', '@aws-sdk/client-s3': '3.1152.0', zod: '4.6.7', 'date-fns': '4.4.0',
};

const work = mkdtempSync(path.join(os.tmpdir(), 'serverless-rspack-bench-'));
const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', work], { cwd: root, encoding: 'utf8' }).trim();
writeFileSync(path.join(work, 'package.json'), '{"private":true}');
execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', path.join(work, tarball),
  ...Object.entries(dependencies).map(([name, version]) => `${name}@${version}`)], { cwd: work, stdio: 'inherit' });

const source = path.join(work, 'source');
mkdirSync(path.join(source, 'src'), { recursive: true });
writeFileSync(path.join(source, 'src/shared.ts'), `
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { formatISO } from 'date-fns';
export const schema = z.object({ id: z.string() });
export const clients = () => ({ db: new DynamoDBClient({}), s3: new S3Client({}), GetItemCommand, GetObjectCommand });
export const now = () => formatISO(new Date());
`);
const names = Array.from({ length: functions }, (_, index) => `fn${index}`);
for (const name of names) {
  writeFileSync(path.join(source, `src/${name}.ts`), `
import { clients, now, schema } from './shared';
export const handler = async (event: unknown) => ({ name: '${name}', at: now(), id: schema.parse(event).id, ready: !!clients() });
`);
}
const yml = (plugin, individually) => `service: bench
provider: { name: aws, runtime: nodejs22.x }
package: { individually: ${individually} }
plugins: ['${plugin}']
custom: { webpack: { webpackConfig: build.config.js, includeModules: false } }
functions:
${names.map((name) => `  ${name}: { handler: src/${name}.handler }`).join('\n')}
`;
const common = (loader, cache) => `
  entry: lib.entries, mode: 'production', target: 'node', externals: [],
  output: { libraryTarget: 'commonjs', path: __dirname + '/.webpack', filename: '[name].js' },
  resolve: { extensions: ['.ts', '.js'] },
  optimization: { minimize: false },
  module: { rules: [{ test: /\\.ts$/, exclude: /node_modules/, loader: '${loader}',
    options: { jsc: { parser: { syntax: 'typescript' }, target: 'es2022' } } }] },
  cache: ${cache},`;
const variants = {
  webpack: {
    plugin: 'serverless-webpack',
    config: `const { lib } = require('serverless-webpack');
module.exports = {${common('swc-loader', "{ type: 'filesystem', cacheDirectory: __dirname + '/.build-cache' }")}};`,
  },
  rspack: {
    plugin: '@alexneamtu/serverless-rspack',
    config: `const { lib } = require('@alexneamtu/serverless-rspack');
module.exports = {${common('builtin:swc-loader', "{ type: 'persistent', storage: { type: 'filesystem', directory: __dirname + '/.build-cache' } }")}};`,
  },
};

const time = (directory) => {
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [path.join(work, 'node_modules/osls/bin/serverless.js'), 'package'],
    { cwd: directory, encoding: 'utf8', env: { ...process.env, SLS_TELEMETRY_DISABLED: '1' } });
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  return Number(process.hrtime.bigint() - started) / 1e9;
};
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const results = [];
for (const individually of [true, false]) for (const [name, variant] of Object.entries(variants)) {
  const directory = path.join(work, `${name}-${individually}`);
  cpSync(source, directory, { recursive: true });
  writeFileSync(path.join(directory, 'serverless.yml'), yml(variant.plugin, individually));
  writeFileSync(path.join(directory, 'build.config.js'), variant.config);
  results.push({ name, packaging: individually ? 'per function' : 'service', directory, cold: [], warm: [] });
}
// Interleave variants so background load affects each one alike.
for (let run = 0; run < runs; run++) {
  for (const result of results) {
    rmSync(path.join(result.directory, '.build-cache'), { recursive: true, force: true });
    result.cold.push(time(result.directory));
    result.warm.push(time(result.directory));
  }
}

console.log(`${functions} functions, ${runs} runs, median seconds; node ${process.version}, ${os.cpus()[0].model} x${os.cpus().length}`);
console.log('| Packaging | Bundler | Cold cache | Warm cache |\n| --- | --- | ---: | ---: |');
for (const { name, packaging, cold, warm } of results) {
  console.log(`| ${packaging} | ${name} | ${median(cold).toFixed(1)} | ${median(warm).toFixed(1)} |`);
}
rmSync(work, { recursive: true, force: true });
