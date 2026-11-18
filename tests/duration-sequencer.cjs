const path = require('node:path');
const Sequencer = require('@jest/test-sequencer').default;

class DurationSequencer extends Sequencer {
  durations = require('./jest-durations.json');

  time(test) {
    const seconds = this.durations[path.relative(test.context.config.rootDir, test.path).replaceAll('\\', '/')];
    return super.time(test) ?? (seconds === undefined ? undefined : seconds * 1000);
  }
}

module.exports = DurationSequencer;
