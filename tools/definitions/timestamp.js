module.exports = {
  name: 'timestamp',
  description: 'Get current date/time or convert between timezones. Supports IANA timezone names like America/New_York, Europe/London, Asia/Tokyo.',
  parameters: {
    type: 'object',
    properties: {
      timezone: { type: 'string', description: 'IANA timezone (default: UTC)' },
      format: { type: 'string', description: 'Format style: short, medium, long, full (default: long)' },
    },
    required: [],
  },
  async execute(args) {
    const tz = args.timezone || 'UTC';
    const style = args.format || 'long';
    const now = new Date();

    const dateOpts = { timeZone: tz, dateStyle: style };
    const timeOpts = { timeZone: tz, timeStyle: style };

    const date = new Intl.DateTimeFormat('en-US', dateOpts).format(now);
    const time = new Intl.DateTimeFormat('en-US', timeOpts).format(now);

    return {
      timezone: tz,
      date,
      time,
      iso: now.toISOString(),
      unix: Math.floor(now.getTime() / 1000),
    };
  },
};
