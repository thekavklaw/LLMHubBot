const { AttachmentBuilder } = require('discord.js');
const logger = require('../logger');

const MAX_MSG_LEN = 2000;

/**
 * Smart split: tries to break at paragraph, then sentence, then word boundaries.
 */
function smartSplit(text, maxLen = MAX_MSG_LEN) {
  if (text.length <= maxLen) return [text];

  const parts = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }

    let splitAt = maxLen;

    // Try paragraph break
    const paraBreak = remaining.lastIndexOf('\n\n', maxLen);
    if (paraBreak > maxLen * 0.3) {
      splitAt = paraBreak;
    } else {
      // Try line break
      const lineBreak = remaining.lastIndexOf('\n', maxLen);
      if (lineBreak > maxLen * 0.3) {
        splitAt = lineBreak;
      } else {
        // Try sentence break
        const sentenceBreak = remaining.lastIndexOf('. ', maxLen);
        if (sentenceBreak > maxLen * 0.3) {
          splitAt = sentenceBreak + 1;
        } else {
          // Try space
          const spaceBreak = remaining.lastIndexOf(' ', maxLen);
          if (spaceBreak > maxLen * 0.3) {
            splitAt = spaceBreak;
          }
        }
      }
    }

    // Handle unclosed code blocks
    const chunk = remaining.slice(0, splitAt);
    const codeBlockCount = (chunk.match(/```/g) || []).length;
    if (codeBlockCount % 2 !== 0) {
      // Unclosed code block — close it and reopen in next chunk
      parts.push(chunk + '\n```');
      remaining = '```\n' + remaining.slice(splitAt).trimStart();
    } else {
      parts.push(chunk);
      remaining = remaining.slice(splitAt).trimStart();
    }
  }

  return parts;
}

/**
 * Layer 4: Response Synthesis
 * Polishes raw execution output for Discord delivery.
 */
async function synthesize(result, intent, context) {
  const { userId } = context;

  if (!result.text && result.images.length === 0) {
    logger.info('Synthesize', 'Empty result — nothing to send');
    return { action: 'ignore', reason: 'Empty result', messages: [], images: [] };
  }

  const text = result.text || '';
  const parts = smartSplit(text);
  const totalLen = text.length;
  logger.info('Synthesize', `Output: ${parts.length} message(s), total ${totalLen} chars, ${result.images.length} image(s)`);
  if (parts.length > 1) {
    logger.debug('Synthesize', `Split into ${parts.length} parts: [${parts.map(p => p.length).join(', ')}] chars`);
  }

  // Build Discord message objects with multi-message support
  const messages = [];
  const imageFiles = [];

  // Prepare image attachments
  for (let i = 0; i < result.images.length; i++) {
    const img = result.images[i];
    if (img.image_buffer) {
      const buf = Buffer.from(img.image_buffer, 'base64');
      imageFiles.push(new AttachmentBuilder(buf, { name: `generated_${i + 1}.png` }));
    }
  }

  const hasImages = imageFiles.length > 0;

  if (hasImages && parts.length > 0) {
    // Multi-message: text first, then images with delay (feels natural)
    for (const part of parts) {
      messages.push({ content: part, files: [], delayMs: 0 });
    }
    // Send images as a separate follow-up message
    messages.push({ content: null, files: imageFiles, delayMs: 500 });
  } else if (parts.length > 0) {
    // Text only — send all parts
    for (const part of parts) {
      messages.push({ content: part, files: [], delayMs: 0 });
    }
  } else if (hasImages) {
    // Images only
    messages.push({ content: null, files: imageFiles, delayMs: 0 });
  }

  // Add follow-up messages from result if any
  if (result.followUps && Array.isArray(result.followUps)) {
    for (const followUp of result.followUps) {
      messages.push({
        content: followUp.content || null,
        files: followUp.files || [],
        delayMs: followUp.delayMs || 1000,
      });
    }
  }

  return {
    action: 'respond',
    messages,
    images: result.images,
    text: result.text,
    toolsUsed: result.toolsUsed || [],
  };
}

module.exports = { synthesize, smartSplit };
