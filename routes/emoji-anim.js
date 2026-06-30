const Router = require('koa-router')
const EmojiAnimationService = require('../utils/emoji-animation-service')

const router = new Router()

/**
 * GET /emoji-anim/:emoji_id
 * Serves animated custom emoji WebP files
 */
router.get('/:emoji_id', async (ctx) => {
  const emojiId = ctx.params.emoji_id

  if (!emojiId) {
    ctx.status = 400
    ctx.body = { error: 'Missing emoji_id' }
    return
  }

  const bot = ctx.app.get('bot')
  if (!bot) {
    ctx.status = 500
    ctx.body = { error: 'Bot not initialized' }
    return
  }

  try {
    const webpPath = await EmojiAnimationService.getEmojiAnimPath(bot, emojiId)

    if (!webpPath) {
      ctx.status = 404
      ctx.body = { error: 'Emoji not found' }
      return
    }

    ctx.set('Content-Type', 'image/webp')
    ctx.set('Cache-Control', 'public, max-age=86400') // Cache for 24 hours
    ctx.body = require('fs').createReadStream(webpPath)
  } catch (error) {
    console.error('Error serving animated emoji:', error.message)
    ctx.status = 500
    ctx.body = { error: 'Failed to serve emoji' }
  }
})

module.exports = router