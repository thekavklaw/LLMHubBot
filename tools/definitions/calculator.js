const logger = require('../../logger');

// Whitelist: only digits, operators, parens, dots, spaces, and Math functions
const ALLOWED_PATTERN = /^[0-9+\-*/().,%^ \t]+$|Math\./;
const MATH_FUNCS = ['abs','ceil','floor','round','sqrt','pow','min','max','log','log2','log10','sin','cos','tan','PI','E','random','trunc','sign'];
const DANGEROUS = /(?:process|require|import|eval|Function|global|this|constructor|prototype|__proto__|setTimeout|setInterval|fetch|Buffer|child_process|fs|net|os|http)/i;

function sanitize(expr) {
  if (typeof expr !== 'string') throw new Error('Expression must be a string');
  if (expr.length > 200) throw new Error('Expression too long (max 200 chars)');
  if (DANGEROUS.test(expr)) throw new Error('Blocked: unsafe expression');

  // Replace Math function names with Math.name
  let sanitized = expr;
  for (const fn of MATH_FUNCS) {
    sanitized = sanitized.replace(new RegExp(`\\b${fn}\\b`, 'g'), `Math.${fn}`);
  }
  // Fix double Math.Math.
  sanitized = sanitized.replace(/Math\.Math\./g, 'Math.');

  // After substitution, check that remaining chars are safe
  const stripped = sanitized.replace(/Math\.\w+/g, '0');
  if (!/^[0-9+\-*/().,%^ \t]+$/.test(stripped)) {
    throw new Error('Blocked: contains disallowed characters');
  }

  return sanitized;
}

module.exports = {
  name: 'calculator',
  description: 'Evaluate mathematical expressions safely. Supports basic arithmetic and Math functions (sqrt, sin, cos, pow, etc).',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Mathematical expression to evaluate (e.g. "sqrt(144) + 2^3")' },
    },
    required: ['expression'],
  },
  async execute(args) {
    const sanitized = sanitize(args.expression);
    // Use ^ as power operator
    const withPow = sanitized.replace(/(\d+(?:\.\d+)?)\s*\^\s*(\d+(?:\.\d+)?)/g, 'Math.pow($1,$2)');
    const result = new Function('return ' + withPow)();
    if (typeof result !== 'number' || !isFinite(result)) {
      throw new Error('Result is not a finite number');
    }
    return { expression: args.expression, result };
  },
  // Exported for testing
  _sanitize: sanitize,
};
