const fs = require('node:fs');
const path = require('node:path');
const { DefaultReporter } = require('@jest/reporters');

class FailingConsoleReporter extends DefaultReporter {
  constructor(globalConfig, reporterConfig, reporterContext) {
    super(globalConfig, reporterConfig, reporterContext);
    this.rootDir = globalConfig.rootDir;
    this.events = process.env.TESTBOX_OUT ? path.join(process.env.TESTBOX_OUT, 'jest-files.jsonl') : null;
    this.hiddenFiles = 0;
    this.hiddenCalls = 0;
  }

  event(entry) {
    if (this.events) fs.appendFileSync(this.events, `${JSON.stringify({ ...entry, run: process.pid })}\n`);
  }

  onTestStart(test) {
    super.onTestStart(test);
    this.event({ e: 'start', file: path.relative(this.rootDir, test.path), t: Date.now() });
  }

  onTestResult(test, result, aggregated) {
    const failed = result.numFailingTests > 0 || Boolean(result.testExecError) || Boolean(result.failureMessage);
    this.event({
      e: 'end',
      file: path.relative(this.rootDir, test.path),
      ms: Math.round(result.perfStats.end - result.perfStats.start),
      failed,
      tests: result.testResults.length,
    });
    if (!failed && result.console && result.console.length) {
      this.hiddenFiles += 1;
      this.hiddenCalls += result.console.length;
      result = { ...result, console: undefined };
    }
    super.onTestResult(test, result, aggregated);
  }

  onRunComplete(testContexts, aggregated) {
    if (this.hiddenFiles) {
      this.log(`Console output hidden for ${this.hiddenFiles} passing files (${this.hiddenCalls} calls); failing files print theirs. JEST_CONSOLE=all shows every file (on a test box: JEST_CONSOLE=all testbox run).`);
    }
    super.onRunComplete(testContexts, aggregated);
  }
}

module.exports = FailingConsoleReporter;
