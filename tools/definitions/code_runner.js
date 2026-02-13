const { Sandbox } = require('@e2b/code-interpreter');
const logger = require('../../logger');

module.exports = {
  name: 'code_runner',
  description: 'Execute Python or JavaScript code in a secure cloud sandbox. Returns stdout, stderr, and results.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Code to execute' },
      language: { type: 'string', enum: ['python', 'javascript'], description: 'Programming language (default: python)' },
    },
    required: ['code'],
  },
  timeout: 30000,
  async execute(args) {
    const lang = (args.language || 'python').toLowerCase();
    if (lang !== 'python' && lang !== 'javascript' && lang !== 'js') {
      throw new Error(`Unsupported language: ${lang}. Use "python" or "javascript".`);
    }

    if (args.code.length > 10000) throw new Error('Code too long (max 10000 chars)');

    let sandbox;
    try {
      sandbox = await Sandbox.create();

      // For JavaScript, wrap in a Node.js execution via Python subprocess
      let code = args.code;
      if (lang === 'javascript' || lang === 'js') {
        // E2B supports JS via node - write to file and execute
        const escaped = code.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
        code = `import subprocess\nresult = subprocess.run(['node', '-e', '${escaped}'], capture_output=True, text=True, timeout=10)\nprint(result.stdout, end='')\nif result.stderr:\n    import sys; print(result.stderr, end='', file=sys.stderr)`;
      }

      const execution = await sandbox.runCode(code, { timeoutMs: 10000 });

      return {
        success: !execution.error,
        stdout: (execution.logs?.stdout || []).join('\n'),
        stderr: (execution.logs?.stderr || []).join('\n'),
        results: (execution.results || []).map(r => r.text || r.toString()).join('\n'),
        error: execution.error ? execution.error.value : null,
        language: lang,
      };
    } catch (err) {
      logger.error('CodeRunner', `E2B execution error: ${err.message}`);
      return { success: false, error: err.message, stdout: '', stderr: '', results: '' };
    } finally {
      if (sandbox) {
        try { await sandbox.kill(); } catch (_) {}
      }
    }
  },
};
