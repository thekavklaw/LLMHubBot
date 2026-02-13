const logger = require('../logger');
const { relevanceGate } = require('./layer1-gate');
const { analyzeIntent } = require('./layer2-intent');
const { execute } = require('./layer3-execute');
const { synthesize } = require('./layer4-synthesize');
const { reflect } = require('./layer5-reflect');

/**
 * 5-Layer Thinking Orchestrator
 * 
 * Layer 1: Relevance Gate — should we respond?
 * Layer 2: Intent Analysis — what does the user want?
 * Layer 3: Execution — agent loop with tools
 * Layer 4: Response Synthesis — polish for Discord
 * Layer 5: Reflection — async learning (non-blocking)
 */
class ThinkingOrchestrator {
  constructor({ toolRegistry, agentLoop, config }) {
    this.toolRegistry = toolRegistry;
    this.agentLoop = agentLoop;
    this.config = config;
    logger.info('Orchestrator', '5-layer thinking system initialized');
  }

  /**
   * Process a message through all 5 layers.
   * @param {Object} message - { content, author, attachments, ... }
   * @param {Object} context - { userId, userName, channelId, botId, inThread, mentionsBot, repliesToBot, gptChannelId }
   * @returns {Object} { action, messages, images, reason }
   */
  async process(message, context) {
    // Inject dependencies into context
    const fullContext = {
      ...context,
      toolRegistry: this.toolRegistry,
      agentLoop: this.agentLoop,
      agentLoopTimeout: this.config.agentLoopTimeout || 60000,
    };

    // Layer 1: Relevance Gate
    const gate = await relevanceGate(message, fullContext);
    logger.debug('Orchestrator', `Gate: engage=${gate.engage} reason="${gate.reason}" confidence=${gate.confidence}`);

    if (!gate.engage) {
      return { action: 'ignore', reason: gate.reason, messages: [], images: [] };
    }

    // Layer 2: Intent Analysis
    const intent = await analyzeIntent(message, fullContext, gate);
    logger.debug('Orchestrator', `Intent: ${intent.intent} tone=${intent.tone} tools=[${intent.suggestedTools.join(',')}]`);

    // Layer 3: Execution
    const result = await execute(message, fullContext, intent);

    // Layer 4: Response Synthesis
    const response = await synthesize(result, intent, fullContext);

    // Layer 5: Reflection (async, non-blocking)
    setImmediate(() => {
      reflect(message, response, fullContext).catch(err =>
        logger.error('Orchestrator', 'Reflection error:', err)
      );
    });

    return response;
  }
}

module.exports = ThinkingOrchestrator;
