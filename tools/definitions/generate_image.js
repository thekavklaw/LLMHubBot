const logger = require('../../logger');

module.exports = {
  name: 'generate_image',
  description: 'Generate an image using AI. Use when the user wants to visualize something, create art, or when an image would enhance the explanation.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed image generation prompt' },
      size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536'], description: 'Image size' },
    },
    required: ['prompt'],
  },
  timeout: 60000,
  async execute(args, context) {
    const { generateImage } = require('../../openai-client');
    const size = args.size || '1024x1024';
    const buffer = await generateImage(args.prompt, size);

    // Store full image data in context for later attachment sending
    context.generatedImages = context.generatedImages || [];
    context.generatedImages.push({
      image_buffer: buffer.toString('base64'),
      prompt_used: args.prompt,
      size,
    });

    // Return ONLY metadata to the model — no base64
    return {
      success: true,
      description: `Generated image: "${args.prompt}"`,
      size,
    };
  },
};
