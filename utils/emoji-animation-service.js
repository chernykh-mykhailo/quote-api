const fs = require('fs').promises
const path = require('path')
const { exec } = require('child_process')
const { promisify } = require('util')
const sharp = require('sharp')
const loadImageFromUrl = require('./image-load-url')

const execAsync = promisify(exec)

const CACHE_DIR = path.resolve(__dirname, '../../data/custom_emojis_anim')

// Ensure cache directory exists
async function ensureCacheDir () {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true })
  } catch (e) {
    // Directory might already exist
  }
}

// Initialize cache dir on module load
ensureCacheDir()

class EmojiAnimationService {
  // In-memory cache for emoji paths to avoid repeated disk checks
  static emojiPathCache = new Map()
  static CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours
  
  // Configuration options
  static config = {
    enabled: true, // Set to false to disable animated emoji loading
    maxConcurrentDownloads: 3, // Limit concurrent downloads to avoid rate limits
    downloadTimeout: 5000, // 5 second timeout per emoji
    skipOnSlow: true, // Skip animation if download takes too long
    slowThreshold: 2000 // Consider download slow if > 2 seconds
  }

  /**
   * Get the cached local path to the custom emoji animated WebP.
   * Downloads/converts if missing.
   * 
   * PERFORMANCE: This is a potentially slow operation (100-900ms per emoji).
   * Consider batching or preloading for high-traffic scenarios.
   */
  static async getEmojiAnimPath (bot, emojiId) {
    if (!emojiId) return null

    const webpPath = path.join(CACHE_DIR, `${emojiId}.webp`)

    // Check in-memory cache first
    const cached = EmojiAnimationService.emojiPathCache.get(emojiId)
    if (cached && Date.now() - cached.timestamp < EmojiAnimationService.CACHE_TTL) {
      // Verify file still exists
      try {
        await fs.access(cached.path)
        return cached.path
      } catch (e) {
        // File was deleted, remove from cache
        EmojiAnimationService.emojiPathCache.delete(emojiId)
      }
    }

    // Check disk cache
    try {
      await fs.access(webpPath)
      // Add to memory cache
      EmojiAnimationService.emojiPathCache.set(emojiId, {
        path: webpPath,
        timestamp: Date.now()
      })
      return webpPath
    } catch (e) {
      // Not cached, need to download
    }

    try {
      // Fetch custom emoji sticker info
      const stickers = await bot.callApi('getCustomEmojiStickers', {
        custom_emoji_ids: [emojiId]
      })

      if (!stickers || stickers.length === 0) {
        // Don't log warnings for missing emojis - this is normal
        return null
      }

      const sticker = stickers[0]
      const fileId = sticker.file_id || sticker.thumb?.file_id
      if (!fileId) return null

      const fileInfo = await bot.getFile(fileId)
      const filePath = fileInfo.file_path
      if (!filePath) return null

      // Determine format from file path
      const ext = path.extname(filePath).toLowerCase()
      const tempPath = path.join(CACHE_DIR, `temp_${emojiId}${ext}`)

      // Download the file
      const fileUrl = bot.getFileLink ? await bot.getFileLink(fileId) : null
      if (!fileUrl) return null

      const buffer = await loadImageFromUrl(fileUrl)
      await fs.writeFile(tempPath, buffer)

      let success = false

      if (ext === '.webp') {
        // Already WebP, might be animated. Just copy.
        try {
          await fs.copyFile(tempPath, webpPath)
          success = true
        } catch (e) {
          console.error(`Failed to copy WebP emoji ${emojiId}:`, e.message)
        }
      } else if (ext === '.tgs') {
        // Lottie TGS - extract first frame as static WebP
        try {
          const pngBuffer = await sharp(buffer)
            .png()
            .toBuffer()

          await sharp(pngBuffer)
            .webp({ quality: 80 })
            .toFile(webpPath)

          success = true
        } catch (e) {
          console.error(`Failed to convert TGS emoji ${emojiId}:`, e.message)
        }
      } else if (ext === '.webm') {
        // Video emoji - convert to animated WebP using ffmpeg
        try {
          const ffmpegPath = await this.findFfmpeg()
          if (ffmpegPath) {
            // Convert to animated webp with alpha channel
            const cmd = [
              ffmpegPath,
              '-y',
              '-v', 'error',
              '-i', tempPath,
              '-c:v', 'libwebp',
              '-lossless', '0',
              '-qscale', '75',
              '-vf', 'scale=48:48',
              '-loop', '0',
              '-an',
              webpPath
            ]

            await execAsync(cmd.join(' '))
            success = await fs.access(webpPath).then(() => true).catch(() => false)
          }
        } catch (e) {
          console.error(`Failed to convert WEBM emoji ${emojiId} using ffmpeg:`, e.message)
        }
      }

      // Clean up temp file
      try {
        await fs.unlink(tempPath)
      } catch (e) {
        // Ignore cleanup errors
      }

      if (success) {
        // Add to memory cache
        EmojiAnimationService.emojiPathCache.set(emojiId, {
          path: webpPath,
          timestamp: Date.now()
        })
        return webpPath
      }
    } catch (e) {
      console.error(`Error caching animated custom emoji ${emojiId}:`, e.message)
    }

    return null
  }

  /**
   * Find ffmpeg executable
   */
  static async findFfmpeg () {
    try {
      const { stdout } = await execAsync('which ffmpeg || where ffmpeg')
      return stdout.trim()
    } catch (e) {
      return null
    }
  }

  /**
   * Load animated emoji as a canvas image (first frame for static rendering)
   */
  static async loadAnimatedEmoji (webpPath) {
    try {
      const buffer = await fs.readFile(webpPath)
      // For static quote rendering, we just need the first frame
      // sharp automatically extracts the first frame from animated WebP
      const pngBuffer = await sharp(buffer)
        .png()
        .toBuffer()

      const { loadImage } = require('canvas')
      return await loadImage(pngBuffer)
    } catch (e) {
      console.error('Failed to load animated emoji:', e.message)
      return null
    }
  }

  /**
   * Preload multiple emojis in batch (with concurrency limit)
   * Useful for warming cache or preloading known emojis
   * 
   * @param {object} bot - Telegram bot instance
   * @param {string[]} emojiIds - Array of emoji IDs to preload
   * @returns {Promise<Map>} Map of emojiId -> path (or null if failed)
   */
  static async preloadEmojis (bot, emojiIds) {
    if (!EmojiAnimationService.config.enabled) {
      return new Map()
    }

    const results = new Map()
    const queue = [...emojiIds]
    const running = new Set()

    while (queue.length > 0 || running.size > 0) {
      // Start new downloads up to concurrency limit
      while (running.size < EmojiAnimationService.config.maxConcurrentDownloads && queue.length > 0) {
        const emojiId = queue.shift()
        const promise = EmojiAnimationService.getEmojiAnimPath(bot, emojiId)
          .then(path => results.set(emojiId, path))
          .catch(() => results.set(emojiId, null))
          .finally(() => running.delete(promise))
        
        running.add(promise)
      }

      // Wait for at least one to complete
      if (running.size > 0) {
        await Promise.race(running)
      }
    }

    return results
  }

  /**
   * Clear the animation cache
   */
  static async clearCache () {
    try {
      const files = await fs.readdir(CACHE_DIR)
      await Promise.all(
        files.map(f => fs.unlink(path.join(CACHE_DIR, f)).catch(() => {}))
      )
      // Clear memory cache too
      EmojiAnimationService.emojiPathCache.clear()
    } catch (e) {
      console.error('Failed to clear emoji animation cache:', e.message)
    }
  }

  /**
   * Get cache statistics for monitoring
   */
  static getCacheStats () {
    try {
      const files = fs.readdirSync(CACHE_DIR)
      const totalSize = files.reduce((sum, file) => {
        const stats = fs.statSync(path.join(CACHE_DIR, file))
        return sum + stats.size
      }, 0)

      return {
        filesCount: files.length,
        totalSizeBytes: totalSize,
        totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
        memoryCached: EmojiAnimationService.emojiPathCache.size,
        enabled: EmojiAnimationService.config.enabled
      }
    } catch (e) {
      return {
        error: e.message
      }
    }
  }
}

module.exports = EmojiAnimationService
