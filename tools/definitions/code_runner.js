const vm = require('vm');
const logger = require('../../logger');

module.exports = {
  name: 'code_runner',
  description: 'Execute JavaScript code in a sandboxed environment. Returns the result and any console output.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'JavaScript code to execute' },
      language: { type: 'string', description: 'Programming language (only "javascript" supported)' },
    },
    required: ['code'],
  },
  timeout: 10000,
  async execute(args) {
    const lang = (args.language || 'javascript').toLowerCase();
    if (lang !== 'javascript' && lang !== 'js') {
      throw new Error(`Unsupported language: ${lang}. Only JavaScript is supported.`);
    }

    if (args.code.length > 5000) throw new Error('Code too long (max 5000 chars)');

    const logs = [];
    const sandbox = {
      console: {
        log: (...a) => logs.push(a.map(String).join(' ')),
        error: (...a) => logs.push('[error] ' + a.map(String).join(' ')),
        warn: (...a) => logs.push('[warn] ' + a.map(String).join(' ')),
      },
      Math, JSON, Date, parseInt, parseFloat, isNaN, isFinite,
      Array, Object, String, Number, Boolean, Map, Set, RegExp,
      setTimeout: undefined, setInterval: undefined,
      process: undefined, require: undefined, global: undefined,
    };

    const ctx = vm.createContext(sandbox);
    const script = new vm.Script(args.code, { timeout: 5000 });

    let result;
    try {
      result = script.runInContext(ctx, { timeout: 5000 });
    } catch (err) {
      if (err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        return { success: false, error: 'Execution timed out (5s limit)', output: logs.join('\n') };
      }
      return { success: false, error: err.message, output: logs.join('\n') };
    }

    // Serialize result
    let resultStr;
    try {
      resultStr = typeof result === 'undefined' ? 'undefined' : JSON.stringify(result, null, 2);
    } catch {
      resultStr = String(result);
    }

    return { success: true, result: resultStr, output: logs.join('\n') };
  },
};
