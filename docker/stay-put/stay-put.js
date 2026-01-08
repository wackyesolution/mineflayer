const mineflayer = require('mineflayer')

const host = process.env.MC_HOST || 'localhost'
const port = parseInt(process.env.MC_PORT || '25565', 10)

const BOT_NAMES = ['bot1', 'bot2', 'bot3', 'bot4', 'bot5']

const mainBotOptions = {
  host,
  port,
  username: process.env.MC_USERNAME || 'StayPutBot',
  auth: process.env.MC_AUTH || 'offline',
  version: process.env.MC_VERSION, // optional override
  password: process.env.MC_PASSWORD
}

let bot = mineflayer.createBot(mainBotOptions)
const bots = new Map()
const ownerAssignments = new Map() // player -> bot name
const botConfigs = new Map() // bot name -> { botName, owner, shouldReconnect, reconnectTimer, schedule, scheduleRaw }
let scheduleMonitor = null
let mainReconnectTimer = null
let mainShouldReconnect = true

trackBot(bot, { withChatHandler: true, onEnd: scheduleMainReconnect })

function resolveBotName (botInstance) {
  return (botInstance?.username || botInstance?.options?.username || '').toLowerCase() || `bot-${Date.now()}`
}

function trackBot (botInstance, { withChatHandler = false, onEnd = null } = {}) {
  const botName = resolveBotName(botInstance)
  const state = {
    bot: botInstance,
    name: botName,
    autoBreakInterval: null,
    autoBreakBusy: false,
    autoAttackInterval: null,
    autoAttackBusy: false,
    toolMonitor: null,
    warnedOutOfTools: { pickaxe: false, axe: false },
    lastToolCount: countTools(botInstance),
    lastHeldKind: null
  }
  bots.set(botName, state)

  botInstance.once('spawn', () => {
    const pos = botInstance.entity.position
    const displayName = botInstance.username || state.name
    console.log(`[${displayName}] Spawned at ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)} on ${host}:${port}`)
    state.lastToolCount = countTools(botInstance)
  })

  if (withChatHandler) {
    botInstance.on('chat', handleChat)
  }

  if (!scheduleMonitor) {
    scheduleMonitor = setInterval(enforceAllSchedules, 15000)
  }

  botInstance.on('playerCollect', (collector, collected) => {
    if (collector !== botInstance.entity) return
    setTimeout(() => announceNewTools(state), 200)
  })

  botInstance.on('kicked', (reason) => console.log(`[${botInstance.username || state.name}] Kicked:`, reason))
  botInstance.on('error', (err) => console.error(`[${botInstance.username || state.name}] Error:`, err))
  botInstance.on('end', () => {
    stopAutoAllFor(botInstance.username || state.name)
    if (state.toolMonitor) clearInterval(state.toolMonitor)
    bots.delete(state.name)
    console.log(`[${botInstance.username || state.name}] Disconnected.`)
    if (typeof onEnd === 'function') onEnd(botInstance.username)
  })

  state.toolMonitor = setInterval(() => {
    ensureToolReady(state).catch((err) => console.error(`[${botInstance.username}] Tool check error:`, err.message))
  }, 1000)
}

function handleChat (username, message) {
  if (!bot || username === bot.username) return
  const lower = message.toLowerCase().trim()

  if (lower.startsWith('=help')) {
    sendHelp()
    return
  }

  if (lower.startsWith('=orario') || lower.startsWith('=bot ')) {
    const reply = handleScheduleCommand(username, message)
    if (reply) bot.chat(reply)
    return
  }

  if (lower.startsWith('=farmblock')) {
    const targetName = message.split(' ').slice(1).join(' ').trim()
    const reply = startBreakingForPlayer(username, targetName)
    if (reply) bot.chat(reply)
    return
  }

  if (lower.startsWith('=stopfarm')) {
    const targetName = message.split(' ').slice(1).join(' ').trim()
    const reply = stopBreakingForPlayer(username, targetName)
    if (reply) bot.chat(reply)
    return
  }

  if (lower.startsWith('=attacca')) {
    const targetName = message.split(' ').slice(1).join(' ').trim()
    const reply = startAttackingForPlayer(username, targetName)
    if (reply) bot.chat(reply)
    return
  }

  if (lower.startsWith('=stopattacca')) {
    const targetName = message.split(' ').slice(1).join(' ').trim()
    const reply = stopAttackingForPlayer(username, targetName)
    if (reply) bot.chat(reply)
    return
  }

  if (lower.startsWith('=spawnatizio') || lower.startsWith('=spawnbot')) {
    const reply = spawnBotForPlayer(username)
    if (reply) bot.chat(reply)
    return
  }

  if (lower.startsWith('=staccabot') || lower.startsWith('=disconnectbot')) {
    const requestedName = message.split(' ').slice(1).join(' ').trim()
    const reply = disconnectBotForPlayer(username, requestedName)
    if (reply) bot.chat(reply)
  }
}

function sendHelp () {
  bot.chat('=spawnatizio / =spawnbot -> crea il tuo bot (max 1 a testa, max 5 totali: bot1-5).')
  bot.chat('=staccabot [nome] -> disconnette il tuo bot e libera lo slot. I bot stanno fermi e si riconnettono da soli.')
  bot.chat('=farmblock [nome] -> il tuo bot rompe in loop il blocco che stai guardando.')
  bot.chat('=stopfarm [nome] -> ferma la rottura automatica.')
  bot.chat('=attacca [nome] -> attacco automatico al mob/giocatore più vicino.')
  bot.chat('=stopattacca [nome] -> ferma l\'attacco automatico.')
  bot.chat('=orario <hh:mm-hh:mm> [nome] oppure =bot <nome> <hh:mm-hh:mm> -> il bot entra/esce agli orari indicati (ora server). Usa "off" per togliere l\'orario.')
}

function handleScheduleCommand (playerName, message) {
  const parts = message.trim().split(/\s+/)
  parts.shift() // drop command (=orario or =bot)

  if (parts.length === 0) {
    return 'Uso: =orario hh:mm-hh:mm [nomeBot] oppure =bot <nomeBot> hh:mm-hh:mm (usa "off" per togliere).'
  }

  let botName = null
  let rangeText = null

  if (/[:\-]/.test(parts[0]) || parts[0].toLowerCase() === 'off') {
    // =orario <range> [name]
    rangeText = parts.shift()
    if (parts.length > 0) botName = parts.shift()
  } else {
    // =bot <name> <range>  OR =bot orario <range>
    botName = parts.shift()
    if (botName?.toLowerCase() === 'orario') botName = null
    rangeText = parts.join(' ')
  }

  if (!rangeText) {
    return 'Uso: =orario hh:mm-hh:mm [nomeBot] oppure =bot <nomeBot> hh:mm-hh:mm.'
  }

  return setScheduleForPlayer(playerName, botName, rangeText)
}

function spawnBotForPlayer (playerName) {
  const ownerKey = playerName.toLowerCase()
  if (ownerAssignments.has(ownerKey)) {
    const assigned = ownerAssignments.get(ownerKey)
    return `Hai già ${assigned}. Usa =staccabot per disconnetterlo.`
  }

  const available = nextAvailableBotName()
  if (!available) {
    return 'Troppi bot al momento.'
  }

  const config = {
    botName: available,
    owner: ownerKey,
    shouldReconnect: true,
    reconnectTimer: null,
    schedule: null,
    scheduleRaw: null
  }

  botConfigs.set(available.toLowerCase(), config)
  ownerAssignments.set(ownerKey, available)
  createAndTrackUserBot(available)
  return `Sto creando ${available} per ${playerName}.`
}

function disconnectBotForPlayer (playerName, requestedBotName) {
  const ownerKey = playerName.toLowerCase()
  const assignedName = ownerAssignments.get(ownerKey)
  const targetName = (requestedBotName || assignedName || '').toLowerCase()

  if (!targetName) return 'Non hai un bot da disconnettere.'

  const config = botConfigs.get(targetName)
  if (!config) return `Non trovo ${requestedBotName || 'quel bot'}.`
  if (config.owner !== ownerKey) return 'Puoi disconnettere solo il tuo bot.'

  config.shouldReconnect = false
  if (config.reconnectTimer) {
    clearTimeout(config.reconnectTimer)
    config.reconnectTimer = null
  }

  botConfigs.delete(targetName)
  ownerAssignments.delete(ownerKey)

  const state = bots.get(targetName)
  if (state?.bot) state.bot.end()

  return `Ho disconnesso ${config.botName}.`
}

function nextAvailableBotName () {
  return BOT_NAMES.find((name) => !botConfigs.has(name.toLowerCase())) || null
}

function getOwnedBotConfig (playerName, requestedBotName) {
  const ownerKey = playerName.toLowerCase()
  const assigned = ownerAssignments.get(ownerKey)
  const chosen = (requestedBotName || assigned || '').toLowerCase()
  if (!chosen) return { error: 'Non hai un bot. Usa =spawnbot per crearne uno.' }
  const config = botConfigs.get(chosen)
  if (!config) return { error: 'Bot non trovato.' }
  if (config.owner !== ownerKey) return { error: 'Puoi controllare solo il tuo bot.' }
  return { config, botName: config.botName }
}

function getOwnedBotState (playerName, requestedBotName) {
  const ownerKey = playerName.toLowerCase()
  const assigned = ownerAssignments.get(ownerKey)
  const chosen = (requestedBotName || assigned || '').toLowerCase()
  if (!chosen) return { error: 'Non hai un bot. Usa =spawnbot per crearne uno.' }
  const config = botConfigs.get(chosen)
  if (!config) return { error: 'Bot non trovato.' }
  if (config.owner !== ownerKey) return { error: 'Puoi controllare solo il tuo bot.' }
  const state = bots.get(chosen)
  if (!state) return { error: 'Il bot non è connesso, sto provando a riconnetterlo.' }
  return { state, botName: config.botName }
}

function createAndTrackUserBot (botName) {
  const config = botConfigs.get(botName.toLowerCase())
  if (!config) return
  if (config.reconnectTimer) {
    clearTimeout(config.reconnectTimer)
    config.reconnectTimer = null
  }

  const newBot = mineflayer.createBot({
    host,
    port,
    username: botName,
    auth: process.env.MC_AUTH || 'offline',
    version: process.env.MC_VERSION,
    password: process.env.MC_PASSWORD
  })

  trackBot(newBot, { onEnd: () => scheduleReconnectFor(botName) })
}

function scheduleReconnectFor (botName) {
  const key = botName.toLowerCase()
  const config = botConfigs.get(key)
  if (!config || !config.shouldReconnect) return
  if (config.reconnectTimer) return

  config.reconnectTimer = setTimeout(() => {
    config.reconnectTimer = null
    console.log(`[${config.botName}] Trying to reconnect...`)
    createAndTrackUserBot(config.botName)
  }, 5000)
}

function parseTimeRange (text) {
  if (!text) return { error: 'Specifica un orario tipo 09:00-15:00.' }
  const trimmed = text.trim()
  if (trimmed.toLowerCase() === 'off') return { disable: true }
  const match = trimmed.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
  if (!match) return { error: 'Formato orario non valido. Usa hh:mm-hh:mm (es: 09:00-15:00).' }
  const [_, sh, sm, eh, em] = match
  const startH = parseInt(sh, 10)
  const startM = parseInt(sm, 10)
  const endH = parseInt(eh, 10)
  const endM = parseInt(em, 10)
  if (startH > 23 || endH > 23 || startM > 59 || endM > 59) return { error: 'Orario fuori range 00:00-23:59.' }
  const start = startH * 60 + startM
  const end = endH * 60 + endM
  return { start, end, raw: `${startH.toString().padStart(2, '0')}:${startM.toString().padStart(2, '0')}-${endH.toString().padStart(2, '0')}:${endM.toString().padStart(2, '0')}` }
}

function isNowWithinSchedule (schedule) {
  if (!schedule) return true
  const now = new Date()
  const minutes = now.getHours() * 60 + now.getMinutes()
  const { start, end } = schedule
  if (start === end) return true // full day
  if (start < end) return minutes >= start && minutes < end
  return minutes >= start || minutes < end // overnight window
}

function enforceScheduleFor (config) {
  if (!config) return
  const key = config.botName.toLowerCase()
  const inWindow = config.schedule ? isNowWithinSchedule(config.schedule) : true

  config.shouldReconnect = inWindow

  if (inWindow) {
    if (!bots.has(key) && !config.reconnectTimer) {
      createAndTrackUserBot(config.botName)
    }
  } else {
    if (config.reconnectTimer) {
      clearTimeout(config.reconnectTimer)
      config.reconnectTimer = null
    }
    const state = bots.get(key)
    if (state?.bot) {
      stopAutoAllFor(config.botName)
      state.bot.end()
    }
  }
}

function enforceAllSchedules () {
  for (const cfg of botConfigs.values()) {
    enforceScheduleFor(cfg)
  }
}

function scheduleMainReconnect () {
  if (!mainShouldReconnect) return
  if (mainReconnectTimer) return

  mainReconnectTimer = setTimeout(() => {
    mainReconnectTimer = null
    console.log('[Main] Trying to reconnect...')
    bot = mineflayer.createBot(mainBotOptions)
    trackBot(bot, { withChatHandler: true, onEnd: scheduleMainReconnect })
  }, 5000)
}

function startAutoBreakingFor (name) {
  const target = bots.get(name.toLowerCase())
  if (!target) return false
  if (target.autoBreakInterval) return true

  target.autoBreakInterval = setInterval(async () => {
    if (target.autoBreakBusy) return
    target.autoBreakBusy = true
    const targetBot = target.bot
    try {
      await ensureToolReady(target)
      if (targetBot.targetDigBlock) return
      const block = targetBot.blockAtCursor()
      if (!block || block.type === 0) return
      await targetBot.dig(block, 'raycast')
    } catch (err) {
      console.error(`[${targetBot.username}] Auto-break error:`, err.message)
    } finally {
      target.autoBreakBusy = false
    }
  }, 250)

  return true
}

function startBreakingForPlayer (playerName, requestedBotName) {
  const { state, botName, error } = getOwnedBotState(playerName, requestedBotName)
  if (error) return error
  const started = startAutoBreakingFor(botName)
  return started ? `${botName} rompe in loop il blocco davanti.` : 'Non posso avviare ora la rottura.'
}

function stopAutoBreakingFor (name) {
  const target = bots.get(name.toLowerCase())
  if (!target) return false
  if (target.autoBreakInterval) {
    clearInterval(target.autoBreakInterval)
    target.autoBreakInterval = null
  }
  if (target.bot.targetDigBlock) target.bot.stopDigging()
  return true
}

function stopBreakingForPlayer (playerName, requestedBotName) {
  const { botName, error } = getOwnedBotState(playerName, requestedBotName)
  if (error) return error
  const stopped = stopAutoBreakingFor(botName)
  return stopped ? `${botName} ha smesso di rompere blocchi.` : 'Non stava rompendo nulla.'
}

function startAutoAttackingFor (name) {
  const target = bots.get(name.toLowerCase())
  if (!target) return false
  if (target.autoAttackInterval) return true

  target.autoAttackInterval = setInterval(async () => {
    if (target.autoAttackBusy) return
    target.autoAttackBusy = true
    const b = target.bot
    try {
      const enemy = b.nearestEntity((e) => e !== b.entity && (e.type === 'mob' || e.type === 'player'))
      if (!enemy) return
      if (b.targetDigBlock) b.stopDigging()
      await b.attack(enemy)
    } catch (err) {
      console.error(`[${target.bot.username || target.name}] Auto-attack error:`, err.message)
    } finally {
      target.autoAttackBusy = false
    }
  }, 500)

  return true
}

function stopAutoAttackingFor (name) {
  const target = bots.get(name.toLowerCase())
  if (!target) return false
  if (target.autoAttackInterval) {
    clearInterval(target.autoAttackInterval)
    target.autoAttackInterval = null
  }
  return true
}

function startAttackingForPlayer (playerName, requestedBotName) {
  const { botName, error } = getOwnedBotState(playerName, requestedBotName)
  if (error) return error
  const started = startAutoAttackingFor(botName)
  return started ? `${botName} attacca automaticamente il bersaglio più vicino.` : 'Non posso avviare ora l\'attacco.'
}

function stopAttackingForPlayer (playerName, requestedBotName) {
  const { botName, error } = getOwnedBotState(playerName, requestedBotName)
  if (error) return error
  const stopped = stopAutoAttackingFor(botName)
  return stopped ? `${botName} ha smesso di attaccare.` : 'Non stava attaccando.'
}

function normalizeName (name) {
  return bots.get(name.toLowerCase())?.bot.username || name
}

function stopAutoAllFor (name) {
  stopAutoBreakingFor(name)
  stopAutoAttackingFor(name)
}

function getToolKind (item) {
  if (!item?.name) return null
  if (item.name.endsWith('_pickaxe')) return 'pickaxe'
  if (item.name.endsWith('_axe')) return 'axe'
  return null
}

function durabilityRemaining (item) {
  if (!item) return 0
  if (!item.maxDurability) return Infinity
  const damageFromNbt = item.nbt?.value?.Damage?.value
  const used = typeof damageFromNbt === 'number' ? damageFromNbt : (item.metadata || 0)
  return item.maxDurability - used
}

function findBestSpare (botInstance, kind, held) {
  const tools = botInstance.inventory.items().filter((it) => getToolKind(it) === kind)
  const heldSlot = held?.slot
  const candidates = tools.filter((it) => it.slot !== heldSlot && durabilityRemaining(it) > 1)
  if (candidates.length === 0) return null
  return candidates.sort((a, b) => durabilityRemaining(b) - durabilityRemaining(a))[0]
}

async function ensureToolReady (state) {
  const b = state.bot
  const held = b.heldItem
  const kind = getToolKind(held)
  if (kind) state.lastHeldKind = kind

  const targetKind = kind || state.lastHeldKind
  if (!targetKind) return

  const remaining = durabilityRemaining(held)
  if (held && remaining > 0) {
    state.warnedOutOfTools[targetKind] = false
    return
  }

  const spare = findBestSpare(b, targetKind, held)
  if (spare) {
    await b.equip(spare, 'hand')
    state.warnedOutOfTools[targetKind] = false
    return
  }

  if (!state.warnedOutOfTools[targetKind]) {
    b.chat(`Sto per finire ${targetKind === 'pickaxe' ? 'i picconi' : 'le asce'} e non ho ricambi!`)
    state.warnedOutOfTools[targetKind] = true
  }
}

function countTools (botInstance) {
  const counts = { pickaxe: 0, axe: 0 }
  if (!botInstance?.inventory?.items) return counts
  const items = botInstance.inventory.items()
  if (!items || !Array.isArray(items)) return counts
  for (const it of items) {
    const kind = getToolKind(it)
    if (kind) counts[kind]++
  }
  return counts
}

function announceNewTools (state) {
  const current = countTools(state.bot)
  const prev = state.lastToolCount

  if (current.pickaxe > prev.pickaxe) {
    state.bot.chat('Ho ricevuto il piccone.')
    state.warnedOutOfTools.pickaxe = false
  }

  if (current.axe > prev.axe) {
    state.bot.chat("Ho ricevuto l'ascia.")
    state.warnedOutOfTools.axe = false
  }

  state.lastToolCount = current
}

process.on('SIGINT', () => {
  console.log('Stopping bots...')
  mainShouldReconnect = false
  if (mainReconnectTimer) {
    clearTimeout(mainReconnectTimer)
    mainReconnectTimer = null
  }

  for (const config of botConfigs.values()) {
    config.shouldReconnect = false
    if (config.reconnectTimer) {
      clearTimeout(config.reconnectTimer)
      config.reconnectTimer = null
    }
  }

  for (const { bot: trackedBot } of bots.values()) {
    trackedBot.end()
  }
  process.exit(0)
})
