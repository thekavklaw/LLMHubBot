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
    const pipelineStart = Date.now();
    const contentPreview = (typeof message.content === 'string' ? message.content : '[media]').slice(0, 80);
    logger.info('Orchestrator', `Processing message from ${context.userName} in ${context.channelId}: "${contentPreview}"`);

    // Inject dependencies into context
    const fullContext = {
      ...context,
      toolRegistry: this.toolRegistry,
      agentLoop: this.agentLoop,
      agentLoopTimeout: this.config.agentLoopTimeout || 60000,
    };

    // Layer 1: Relevance Gate
    let gate;
    const l1Start = Date.now();
    try {
      gate = await relevanceGate(message, fullContext);
      logger.info('Orchestrator', `Layer 1 (Gate): engage=${gate.engage}, reason="${gate.reason}", confidence=${gate.confidence}, time=${Date.now() - l1Start}ms`);
    } catch (err) {
      logger.error('Orchestrator', 'Layer 1 (Gate) failed:', { error: err.message, stack: err.stack });
      return { action: 'ignore', reason: 'Gate error', messages: [], images: [] };
    }

    if (!gate.engage) {
      logger.info('Orchestrator', `Total thinking pipeline: ${Date.now() - pipelineStart}ms (ignored)`);
      return { action: 'ignore', reason: gate.reason, messages: [], images: [] };
    }

    // Layer 2: Intent Analysis
    let intent;
    const l2Start = Date.now();
    try {
      intent = await analyzeIntent(message, fullContext, gate);
      logger.info('Orchestrator', `Layer 2 (Intent): intent=${intent.intent}, tone=${intent.tone}, tools=[${intent.suggestedTools.join(',')}], time=${Date.now() - l2Start}ms`);
    } catch (err) {
      logger.error('Orchestrator', 'Layer 2 (Intent) failed:', { error: err.message, stack: err.stack });
      intent = { intent: 'discussion', suggestedTools: [], tone: 'helpful', memoryContext: [], userContext: null, keyContext: '', approach: '' };
    }

    // Layer 3: Execution
    let result;
    const l3Start = Date.now();
    try {
      result = await execute(message, fullContext, intent);
      logger.info('Orchestrator', `Layer 3 (Execute): ${result.toolsUsed.length} tools, ${result.iterations} iterations, time=${Date.now() - l3Start}ms`);
    } catch (err) {
      logger.error('Orchestrator', 'Layer 3 (Execute) failed:', { error: err.message, stack: err.stack });
      return { action: 'ignore', reason: 'Execution error', messages: [], images: [] };
    }

    // Layer 4: Response Synthesis
    let response;
    const l4Start = Date.now();
    try {
      response = await synthesize(result, intent, fullContext);
      logger.info('Orchestrator', `Layer 4 (Synthesize): action=${response.action}, messages=${(response.messages || []).length}, time=${Date.now() - l4Start}ms`);
    } catch (err) {
      logger.error('Orchestrator', 'Layer 4 (Synthesize) failed:', { error: err.message, stack: err.stack });
      return { action: 'ignore', reason: 'Synthesis error', messages: [], images: [] };
    }

    // Layer 5: Reflection (async, non-blocking)
    setImmediate(() => {
      const l5Start = Date.now();
      reflect(message, response, fullContext)
        .then(() => logger.debug('Orchestrator', `Layer 5 (Reflect): time=${Date.now() - l5Start}ms`))
        .catch(err => logger.error('Orchestrator', 'Layer 5 (Reflect) failed:', { error: err.message, stack: err.stack }));
    });

    logger.info('Orchestrator', `Total thinking pipeline: ${Date.now() - pipelineStart}ms`);
    return response;
  }
}

module.exports = ThinkingOrchestrator;
