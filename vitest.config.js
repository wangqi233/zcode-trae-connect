const { defineConfig } = require('vitest/config');

// Most suites spin up a real server process and talk to it over HTTP, and several
// deliberately exercise slow paths (upstream failure, stream folding). GitHub's
// runners are much slower than a dev machine at process spawn + fs, so the built-in
// 5s default is too tight there. Suites that need even longer set their own timeout.
module.exports = defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    // Suites each bind a port and spawn a server; running them in one process avoids
    // resource contention that made windows runners flaky.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
