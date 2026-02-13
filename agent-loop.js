const logger = require('./logger');

class AgentLoop {
  constructor(registry, openaiClient, config = {}) {
    this.registry = registry;
    this.openai = openaiClient;
    this.maxIterations = config.maxAgentIterations || 10;
    this.timeout = config.agentLoopTimeout || 60000;
  }

  async run(messages, systemPrompt, context) {
    const tools = this.registry.getToolsForOpenAI();
    let iterations = 0;
    const toolCallHistory = [];
    const startTime = Date.now();

    logger.info('AgentLoop', `Agent loop started with ${tools.length} tools available`);

    const fullMessages = [{ role: 'system', content: systemPrompt }, ...messages];

    while (iterations < this.maxIterations) {
      if (Date.now() - startTime > this.timeout) {
        logger.warn('AgentLoop', `Timeout after ${iterations} iterations (${Date.now() - startTime}ms elapsed)`);
        break;
      }

      iterations++;

      const response = await this.openai.createChatCompletion(fullMessages, tools);

      if (!response.tool_calls || response.tool_calls.length === 0) {
        return {
          text: response.content || '',
          toolsUsed: toolCallHistory,
          iterations,
          images: context.generatedImages || [],
        };
      }

      logger.info('AgentLoop', `Iteration ${iterations}/${this.maxIterations}: ${response.tool_calls.length} tool calls`);

      // Add assistant message with tool calls
      fullMessages.push({
        role: 'assistant',
        content: response.content || null,
        tool_calls: response.tool_calls,
      });

      for (const toolCall of response.tool_calls) {
        let args;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          args = {};
        }

        // Duplicate detection
        const callSig = `${toolCall.function.name}:${JSON.stringify(args)}`;
        if (toolCallHistory.includes(callSig)) {
          logger.warn('AgentLoop', `Skipped duplicate call: ${toolCall.function.name}`);
          fullMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: 'Duplicate call skipped',
          });
          continue;
        }
        toolCallHistory.push(callSig);

        const toolStart = Date.now();
        logger.info('AgentLoop', `Tool call #${toolCallHistory.length}: ${toolCall.function.name}(${JSON.stringify(args).substring(0, 100)})`);

        const result = await this.registry.executeTool(toolCall.function.name, args, context);
        logger.info('AgentLoop', `Tool call #${toolCallHistory.length}: ${toolCall.function.name} → ${result.success ? 'success' : 'fail'} in ${Date.now() - toolStart}ms`);

        // Note: generate_image tool now pushes to context.generatedImages directly
        // and returns only metadata (no base64) to avoid bloating the context

        // Truncate result
        let resultStr = JSON.stringify(result.success ? result.result : { error: result.error });
        if (resultStr.length > 2000) {
          resultStr = resultStr.substring(0, 2000) + '... [truncated]';
        }

        fullMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: resultStr,
        });
      }
    }

    // Exhausted iterations — force text response without tools
    logger.warn('AgentLoop', `Max iterations (${this.maxIterations}) reached, forcing text response`);
    const finalResponse = await this.openai.createChatCompletion(fullMessages, []);
    return {
      text: finalResponse.content || '',
      toolsUsed: toolCallHistory,
      iterations,
      images: context.generatedImages || [],
    };
  }
}

module.exports = AgentLoop;
