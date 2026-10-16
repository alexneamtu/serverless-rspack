// Packs this repository, installs the tarball into a clean consumer project and
// packages the examples with a real Serverless CLI. Versions come from the environment
// so CI can run the compatibility matrix.
const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const RSPACK = process.env.RSPACK_VERSION || '2.2.9';
const FRAMEWORK = process.env.FRAMEWORK || 'osls@3.78.0';
const frameworkName = FRAMEWORK.slice(0, FRAMEWORK.lastIndexOf('@'));
const root = path.resolve(__dirname, '..');
let consumer;

before(() => {
  consumer = mkdtempSync(path.join(os.tmpdir(), 'serverless-rspack-consumer-'));
  const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', consumer], { cwd: root, encoding: 'utf8' }).trim();
  writeFileSync(path.join(consumer, 'package.json'), '{"private":true}');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', path.join(consumer, tarball), `@rspack/core@${RSPACK}`, FRAMEWORK], { cwd: consumer, stdio: 'inherit' });
});

after(() => rmSync(consumer, { recursive: true, force: true }));

const service = (example) => {
  const directory = mkdtempSync(path.join(consumer, `${example}-`));
  cpSync(path.join(root, 'examples', example), directory, { recursive: true });
  return directory;
};

const serverless = (directory, ...args) => {
  const result = spawnSync(process.execPath, [serverlessBin(), ...args, '--stage', 'test', '--region', 'us-east-1'], {
    cwd: directory, encoding: 'utf8', timeout: 120_000, env: { ...process.env, SLS_TELEMETRY_DISABLED: '1' },
  });
  return { ...result, output: result.stdout + result.stderr };
};

const packageService = (directory) => {
  const result = serverless(directory, 'package');
  assert.equal(result.status, 0, result.output);
  return result;
};

const unzip = (directory, zip) => {
  const output = mkdtempSync(path.join(directory, 'unzipped-'));
  execFileSync('unzip', ['-q', path.join(directory, '.serverless', zip), '-d', output]);
  return output;
};

// Loads the handler the way the Lambda Node.js runtime does: require() from the task root.
const invoke = (taskRoot, handler, event = {}) => {
  const file = handler.slice(0, handler.lastIndexOf('.'));
  const name = handler.slice(handler.lastIndexOf('.') + 1);
  const script = `Promise.resolve(require(${JSON.stringify(`./${file}.js`)})[${JSON.stringify(name)}](${JSON.stringify(event)}, {}))
    .then((result) => console.log(JSON.stringify(result)))`;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: taskRoot, encoding: 'utf8' }));
};

const config = (directory, overrides) => writeFileSync(path.join(directory, 'rspack.config.js'),
  `module.exports = { ...require('./base.rspack.config.js'), ...${overrides} };`);

test('minimal JavaScript config packages a callable handler in one service ZIP', () => {
  const directory = service('javascript');
  const result = packageService(directory);
  assert.match(result.output, /Rspack: compiling/);
  const taskRoot = unzip(directory, 'rspack-javascript.zip');
  assert.deepEqual(invoke(taskRoot, 'handler.hello', { name: 'Rspack' }), { message: 'Hello, Rspack' });
  // Serverless v4 invoke local loads handlers with import(), which needs statically named exports.
  const imported = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { hello } = await import(${JSON.stringify(path.join(taskRoot, 'handler.js'))}); console.log(JSON.stringify(await hello({ name: 'ESM' })))`], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(imported), { message: 'Hello, ESM' });
  const template = JSON.parse(readFileSync(path.join(directory, '.serverless/cloudformation-template-update-stack.json')));
  assert.equal(template.Resources.HelloLambdaFunction.Properties.Handler, 'handler.hello');
});

test('TypeScript functions package individually with assets and fresh cached builds', () => {
  const directory = service('typescript');
  packageService(directory);
  assert.equal(existsSync(path.join(directory, '.rspack-cache')), true, 'persistent cache must be written');
  assert.deepEqual(invoke(unzip(directory, 'hello.zip'), 'src/hello.handler'), { message: 'Hello from an asset' });
  assert.deepEqual(invoke(unzip(directory, 'counter.zip'), 'src/counter.handler', { count: 1 }), { count: 3 });

  writeFileSync(path.join(directory, 'src/shared.ts'), 'export const step: number = 5;');
  writeFileSync(path.join(directory, 'assets/message.txt'), 'Updated asset');
  packageService(directory);
  assert.deepEqual(invoke(unzip(directory, 'hello.zip'), 'src/hello.handler'), { message: 'Updated asset' });
  assert.deepEqual(invoke(unzip(directory, 'counter.zip'), 'src/counter.handler', { count: 1 }), { count: 6 });
});

test('compilation errors fail packaging with the Rspack message', () => {
  const directory = service('typescript');
  writeFileSync(path.join(directory, 'src/shared.ts'), "export { step } from './missing-module';");
  const result = serverless(directory, 'package');
  assert.notEqual(result.status, 0);
  assert.match(result.output, /missing-module/);
  assert.equal(existsSync(path.join(directory, '.serverless/counter.zip')), false);
});

test('includeModules is rejected', () => {
  const directory = service('javascript');
  const yml = path.join(directory, 'serverless.yml');
  writeFileSync(yml, readFileSync(yml, 'utf8').replace('includeModules: false', 'includeModules: true'));
  const result = serverless(directory, 'package');
  assert.notEqual(result.status, 0);
  assert.match(result.output, /includeModules: false/);
});

test('non-CommonJS output library types are rejected', () => {
  const directory = service('javascript');
  cpSync(path.join(directory, 'rspack.config.js'), path.join(directory, 'base.rspack.config.js'));
  config(directory, `{ output: { library: { type: 'module' }, path: require('node:path').join(__dirname, '.webpack'), filename: '[name].js' } }`);
  const result = serverless(directory, 'package');
  assert.notEqual(result.status, 0);
  assert.match(result.output, /CommonJS/);
});

test('legacy output.libraryTarget is translated for Rspack', () => {
  const directory = service('javascript');
  cpSync(path.join(directory, 'rspack.config.js'), path.join(directory, 'base.rspack.config.js'));
  config(directory, `{ output: { libraryTarget: 'commonjs2', path: require('node:path').join(__dirname, '.webpack'), filename: '[name].js' } }`);
  packageService(directory);
  assert.deepEqual(invoke(unzip(directory, 'rspack-javascript.zip'), 'handler.hello'), { message: 'Hello, world' });
});

test('invoke local runs the compiled handler', () => {
  const result = serverless(service('javascript'), 'invoke', 'local', '--function', 'hello', '--data', '{"name":"local"}');
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Hello, local/);
});

const serverlessBin = () => {
  const pkg = path.join(consumer, 'node_modules', frameworkName);
  return path.join(pkg, require(path.join(pkg, 'package.json')).bin.serverless);
};

// Starts a long-running Serverless command; resolves once its output matches.
const start = (directory, args) => {
  const child = spawn(process.execPath, [serverlessBin(), ...args, '--stage', 'test', '--region', 'us-east-1'],
    { cwd: directory, env: { ...process.env, SLS_TELEMETRY_DISABLED: '1' } });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.waitFor = (pattern, timeout = 60_000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (pattern.test(output)) resolve(clearInterval(poll));
      else if (child.exitCode !== null || Date.now() - started > timeout) {
        clearInterval(poll);
        reject(new Error(`Timed out waiting for ${pattern}:\n${output}`));
      }
    }, 200);
  });
  return child;
};

const freePort = () => new Promise((resolve) => {
  const server = net.createServer().listen(0, () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

test('invoke local --watch recompiles with Rspack after a source change', async () => {
  const directory = service('javascript');
  const child = start(directory, ['invoke', 'local', '--function', 'hello', '--data', '{"name":"watch"}', '--watch']);
  try {
    await child.waitFor(/Hello, watch/);
    writeFileSync(path.join(directory, 'greeting.js'), "exports.greeting = (name) => `Changed, ${name}`;");
    await child.waitFor(/Changed, watch/);
  } finally {
    child.kill();
  }
});

test('serverless offline serves the Rspack-compiled handler', async () => {
  // serverless-offline 14 peers on Serverless v4; 13 is the last line for Serverless 3.
  const offline = FRAMEWORK.startsWith('serverless@3') ? 'serverless-offline@13' : 'serverless-offline@14';
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', offline], { cwd: consumer, stdio: 'inherit' });
  const directory = service('javascript');
  const yml = path.join(directory, 'serverless.yml');
  writeFileSync(yml, readFileSync(yml, 'utf8')
    .replace("  - '@alexneamtu/serverless-rspack'", "  - '@alexneamtu/serverless-rspack'\n  - serverless-offline")
    .replace('handler: handler.hello', 'handler: handler.hello\n    events:\n      - httpApi: GET /hello'));
  const [httpPort, lambdaPort] = [await freePort(), await freePort()];
  const child = start(directory, ['offline', 'start', '--httpPort', String(httpPort), '--lambdaPort', String(lambdaPort)]);
  try {
    await child.waitFor(/Server ready/);
    const response = await fetch(`http://localhost:${httpPort}/hello`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { message: 'Hello, world' });
  } finally {
    child.kill();
  }
});

// Opt-in: runs extracted ZIPs in an AWS Lambda base image through its Runtime Interface Emulator.
test('handlers run in the AWS Lambda Node.js image', { skip: !process.env.LAMBDA_IMAGE }, async () => {
  const directory = service('typescript');
  packageService(directory);
  for (const [zip, handler, expected] of [
    ['hello.zip', 'src/hello.handler', { message: 'Hello from an asset' }],
    ['counter.zip', 'src/counter.handler', { count: 3 }],
  ]) {
    const taskRoot = unzip(directory, zip);
    const container = execFileSync('docker', ['run', '-d', '--rm', '-p', '127.0.0.1::8080',
      '-v', `${taskRoot}:/var/task:ro`, process.env.LAMBDA_IMAGE, handler], { encoding: 'utf8' }).trim();
    try {
      const port = execFileSync('docker', ['port', container, '8080'], { encoding: 'utf8' }).trim().split(':').pop();
      let response;
      for (let attempt = 0; !response && attempt < 50; attempt++) {
        response = await fetch(`http://127.0.0.1:${port}/2015-03-31/functions/function/invocations`,
          { method: 'POST', body: JSON.stringify({ count: 1 }) }).catch(() => new Promise((r) => setTimeout(r, 200)));
      }
      assert.deepEqual(await response.json(), expected);
    } finally {
      execFileSync('docker', ['rm', '-f', container]);
    }
  }
});
