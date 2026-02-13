const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { logToolUsage } = require('../db');

class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    if (!tool.name || !tool.description || !tool.parameters || !tool.execute) {
      throw new Error(`Tool registration failed: missing required fields (name=${tool.name})`);
    }
    this.tools.set(tool.name, tool);
    logger.info('ToolRegistry', `Registered tool: ${tool.name}`);
  }

  loadAll() {
    const defsDir = path.join(__dirname, 'definitions');
    if (!fs.existsSync(defsDir)) {
      logger.warn('ToolRegistry', 'No definitions/ directory found');
      return;
    }

    const files = fs.readdirSync(defsDir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      try {
        const tool = require(path.join(defsDir, file));
        this.register(tool);
        logger.info('ToolRegistry', `Loaded tool: ${tool.name} from ${file}`);
      } catch (err) {
        logger.error('ToolRegistry', `Failed to load tool from ${file}:`, { error: err.message, stack: err.stack });
      }
    }
    logger.info('ToolRegistry', `Loaded ${this.tools.size} tools`);
  }

  getTool(name) {
    return this.tools.get(name);
  }

  getToolsForOpenAI(filter) {
    const tools = [];
    for (const tool of this.tools.values()) {
      if (filter && !filter(tool)) continue;
      tools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      });
    }
    return tools;
  }

  async executeTool(name, args, context) {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, result: null, error: `Unknown tool: ${name}` };
    }

    const timeout = tool.timeout || 30000;
    const start = Date.now();
    logger.debug('ToolRegistry', `Executing tool ${name} with args: ${JSON.stringify(args).slice(0, 200)}`);

    try {
      const result = await Promise.race([
        tool.execute(args, context),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Tool execution timed out')), timeout)),
      ]);
      const elapsed = Date.now() - start;
      logger.info('ToolRegistry', `Tool ${name} completed in ${elapsed}ms, success=true`);
      try { logToolUsage(name, context?.userId, context?.channelId, true, elapsed); } catch (_) {}
      return { success: true, result, error: null };
    } catch (err) {
      const elapsed = Date.now() - start;
      logger.error('ToolRegistry', `Tool ${name} completed in ${elapsed}ms, success=false:`, { error: err.message, stack: err.stack });
      try { logToolUsage(name, context?.userId, context?.channelId, false, elapsed); } catch (_) {}
      return { success: false, result: null, error: err.message };
    }
  }

  listTools() {
    return Array.from(this.tools.values()).map(t => ({
      name: t.name,
      description: t.description,
    }));
  }
}

module.exports = ToolRegistry;
