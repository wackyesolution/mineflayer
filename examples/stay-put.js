const mineflayer = require('mineflayer')

// Basic idle bot: connects and stays still until you stop the process.
const host = process.env.MC_HOST || '192.168.2.179'
const port = parseInt(process.env.MC_PORT || '25565', 10)

const bot = mineflayer.createBot({
  host,
  port,
  username: process.env.MC_USERNAME || 'StayPutBot',
  auth: process.env.MC_AUTH || 'offline',
  version: process.env.MC_VERSION // optional: force a specific version if needed
})

bot.once('spawn', () => {
  const pos = bot.entity.position
  console.log(`Spawned and idle at ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)} on ${host}:${port}`)
})

bot.on('kicked', (reason) => console.log('Kicked:', reason))
bot.on('error', (err) => console.error('Error:', err))

process.on('SIGINT', () => {
  console.log('Stopping bot...')
  bot.end()
  process.exit(0)
})
