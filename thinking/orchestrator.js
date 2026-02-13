/**
 * @module thinking/orchestrator
 * @description 5-layer thinking pipeline orchestrator. Runs messages through
 * Gate → Intent → Execute → Synthesize → Reflect with graceful degradation
 * under load and comprehensive error recovery at each layer.
 */

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
/**
 * Determine load level from queue stats for graceful degradation.
 */
function getLoadLevel(queueStats) {
  if (!queueStats || !queueStats.main) return 1;
  const mainDepth = queueStats.main.pending || 0;
  if (mainDepth > 40) return 4; // critical
  if (mainDepth > 25) return 3; // high
  if (mainDepth > 10) return 2; // moderate
  return 1; // normal
}

class ThinkingOrchestrator {
  constructor({ toolRegistry, agentLoop, config }) {
    this.toolRegistry = toolRegistry;
    this.agentLoop = agentLoop;
    this.config = config;
    this._modelQueue = null; // set externally
    logger.info('Orchestrator', '5-layer thinking system initialized');
  }

  setModelQueue(mq) { this._modelQueue = mq; }

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

    // Determine load level for graceful degradation
    const queueStats = this._modelQueue ? this._modelQueue.getStats() : null;
    const loadLevel = getLoadLevel(queueStats);
    if (loadLevel >= 2) {
      logger.info('Orchestrator', `Load level ${loadLevel} — degrading gracefully`);
    }

    // Inject dependencies into context
    const fullContext = {
      ...context,
      toolRegistry: this.toolRegistry,
      agentLoop: this.agentLoop,
      agentLoopTimeout: this.config.agentLoopTimeout || 60000,
      loadLevel,
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
      logger.error('Orchestrator', 'Layer 3 (Execute) failed, falling back to direct response:', { error: err.message, stack: err.stack });
      // Fallback: try direct GPT response without tools
      try {
        const { generateResponse } = require('../openai-client');
        const { getContext } = require('../context');
        const { getSystemPrompt } = require('../soul');
        const systemPrompt = await getSystemPrompt(context.channelId, context.userId, message.content);
        const contextMsgs = getContext(context.channelId);
        const text = await generateResponse(
          [{ role: 'system', content: systemPrompt }, ...contextMsgs],
          { tools: false, maxTokens: 1000 }
        );
        result = { text, toolsUsed: [], iterations: 0, images: [] };
      } catch (fallbackErr) {
        logger.error('Orchestrator', 'Layer 3 fallback also failed:', { error: fallbackErr.message });
        const { friendlyError } = require('../utils/errors');
        return {
          action: 'respond',
          messages: [{ content: friendlyError(fallbackErr) }],
          images: [], text: '', toolsUsed: [],
        };
      }
    }

    // Layer 4: Response Synthesis
    let response;
    const l4Start = Date.now();
    try {
      response = await synthesize(result, intent, fullContext);
      logger.info('Orchestrator', `Layer 4 (Synthesize): action=${response.action}, messages=${(response.messages || []).length}, time=${Date.now() - l4Start}ms`);
    } catch (err) {
      logger.error('Orchestrator', 'Layer 4 (Synthesize) failed, sending raw text:', { error: err.message, stack: err.stack });
      // Fallback: send raw text without formatting
      if (result && result.text) {
        const rawParts = result.text.match(/[\s\S]{1,2000}/g) || [];
        response = {
          action: 'respond',
          messages: rawParts.map(p => ({ content: p })),
          images: result.images || [],
          text: result.text,
          toolsUsed: result.toolsUsed || [],
        };
      } else {
        return { action: 'ignore', reason: 'Synthesis error with no text', messages: [], images: [] };
      }
    }

    // Layer 5: Reflection (async, non-blocking) — skip under load
    if (loadLevel <= 1) {
      setImmediate(() => {
        const l5Start = Date.now();
        reflect(message, response, fullContext)
          .then(() => logger.debug('Orchestrator', `Layer 5 (Reflect): time=${Date.now() - l5Start}ms`))
          .catch(err => logger.error('Orchestrator', 'Layer 5 (Reflect) failed:', { error: err.message, stack: err.stack }));
      });
    } else {
      logger.debug('Orchestrator', `Skipping reflection (load level ${loadLevel})`);
    }

    logger.info('Orchestrator', `Total thinking pipeline: ${Date.now() - pipelineStart}ms`);
    return response;
  }
}

module.exports = ThinkingOrchestrator;
