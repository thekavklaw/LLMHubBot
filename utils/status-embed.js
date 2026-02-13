const { EmbedBuilder } = require('discord.js');

const STAGES = [
  { key: 'gate', label: 'Relevance', emoji: '🔍' },
  { key: 'intent', label: 'Intent', emoji: '🎯' },
  { key: 'memory', label: 'Memory', emoji: '🧠' },
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
    this.toolActive = null; // currently executing tool
    this.pendingUpdate = null;
    this.deleted = false;
    this.timerInterval = null;
    this._shown = false;
  }

  /** Show immediately — no delay. */
  async show() {
    if (this._shown || this.deleted) return;
    this._shown = true;
    try {
      const embed = this._buildEmbed();
      this.message = await this.channel.send({ embeds: [embed] });
      // Start a timer that updates the elapsed time every 1s
      this.timerInterval = setInterval(() => this._timerTick(), 1000);
    } catch (_) {}
  }

  async updateStage(key, status, detail = '') {
    this.stages[key] = { status, detail, time: Date.now() - this.startTime };
    await this._throttledEdit();
  }

  async addTool(toolName) {
    this.toolActive = toolName;
    // Update execute stage with current tool
    this.stages.execute = {
      status: 'active',
      detail: `calling ${toolName}...`,
      time: Date.now() - this.startTime,
    };
    await this._throttledEdit();
  }

  async toolDone(toolName) {
    if (!this.toolsUsed.includes(toolName)) this.toolsUsed.push(toolName);
    this.toolActive = null;
    this.stages.execute = {
      status: 'active',
      detail: this.toolsUsed.length === 1
        ? `used ${toolName}`
        : `used ${this.toolsUsed.length} tools`,
      time: Date.now() - this.startTime,
    };
    await this._throttledEdit();
  }

  async destroy() {
    this.deleted = true;
    if (this.timerInterval) clearInterval(this.timerInterval);
    if (this.pendingUpdate) clearTimeout(this.pendingUpdate);
    try { if (this.message) await this.message.delete(); } catch (_) {}
  }

  _buildEmbed() {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

    const lines = STAGES.map(s => {
      const state = this.stages[s.key];
      if (!state || state.status === 'pending') return `⬜ ${s.label}`;
      if (state.status === 'active') {
        const detail = state.detail ? ` — ${state.detail}` : '';
        return `🔄 **${s.label}**${detail}`;
      }
      if (state.status === 'done') {
        const ms = state.time ? ` (${state.time}ms)` : '';
        const detail = state.detail ? ` — ${state.detail}` : '';
        return `✅ ${s.label}${detail}${ms}`;
      }
      return `⬜ ${s.label}`;
    });

    if (this.toolsUsed.length > 0) {
      const toolList = this.toolsUsed.map(t => `\`${t}\``).join(' → ');
      lines.push(`\n🔧 ${toolList}`);
    }

    return new EmbedBuilder()
      .setColor(0x5865F2)
      .setDescription(lines.join('\n'))
      .setFooter({ text: `⏱️ ${elapsed}s` });
  }

  /** Periodic timer tick to update elapsed display */
  async _timerTick() {
    if (this.deleted || !this.message) return;
    const now = Date.now();
    // Only tick-update if nothing else edited recently (avoid conflicts)
    if (now - this.lastEdit >= 900) {
      this.lastEdit = now;
      try { await this.message.edit({ embeds: [this._buildEmbed()] }); } catch (_) {}
    }
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
