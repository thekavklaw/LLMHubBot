const { EmbedBuilder } = require('discord.js');

const STAGES = [
  { key: 'gate', label: 'Relevance', emoji: '🔍' },
  { key: 'intent', label: 'Intent', emoji: '🎯' },
  { key: 'execute', label: 'Processing', emoji: '⚡' },
  { key: 'synthesize', label: 'Synthesize', emoji: '✨' },
  { key: 'reflect', label: 'Reflect', emoji: '💭' },
];

class StatusEmbed {
  constructor(channel) {
    this.channel = channel;
    this.message = null;
    this.stages = {};
    this.startTime = Date.now();
    this.lastEdit = 0;
    this.toolsUsed = [];
    this.pendingUpdate = null;
    this.deleted = false;
  }

  async show() {
    try {
      const embed = this._buildEmbed();
      this.message = await this.channel.send({ embeds: [embed] });
    } catch (_) {}
  }

  async updateStage(key, status, detail = '') {
    this.stages[key] = { status, detail };
    await this._throttledEdit();
  }

  async addTool(toolName) {
    this.toolsUsed.push(toolName);
    await this._throttledEdit();
  }

  async destroy() {
    this.deleted = true;
    if (this.pendingUpdate) clearTimeout(this.pendingUpdate);
    try { if (this.message) await this.message.delete(); } catch (_) {}
  }

  _buildEmbed() {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const lines = STAGES.map(s => {
      const state = this.stages[s.key];
      if (!state || state.status === 'pending') return `⬜ ${s.label}`;
      if (state.status === 'active') return `🔄 **${s.label}**${state.detail ? ' — ' + state.detail : ''}`;
      if (state.status === 'done') return `✅ ${s.label}${state.detail ? ' — ' + state.detail : ''}`;
      return `⬜ ${s.label}`;
    });

    if (this.toolsUsed.length > 0) {
      lines.push(`\n🔧 Tools: ${this.toolsUsed.join(', ')}`);
    }

    return new EmbedBuilder()
      .setColor(0x5865F2)
      .setDescription(lines.join('\n'))
      .setFooter({ text: `⏱️ ${elapsed}s` });
  }

  async _throttledEdit() {
    if (this.deleted || !this.message) return;
    const now = Date.now();
    const timeSinceLastEdit = now - this.lastEdit;

    if (timeSinceLastEdit >= 500) {
      this.lastEdit = now;
      try { await this.message.edit({ embeds: [this._buildEmbed()] }); } catch (_) {}
    } else {
      if (this.pendingUpdate) clearTimeout(this.pendingUpdate);
      this.pendingUpdate = setTimeout(() => this._throttledEdit(), 500 - timeSinceLastEdit + 10);
    }
  }
}

module.exports = { StatusEmbed };
