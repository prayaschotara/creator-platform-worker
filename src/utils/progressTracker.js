const Redis = require('ioredis');
const winston = require('winston');

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.simple(),
    transports: [new winston.transports.Console()]
});

class ProgressTracker {
    constructor() {
        this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    }

    async getProgress(postId) {
        try {
            const progress = await this.redis.get(`progress:${postId}`);
            return progress ? JSON.parse(progress) : null;
        } catch (error) {
            logger.error(`Failed to get progress for ${postId}:`, error);
            return null;
        }
    }

    async getMaxProgress(postId) {
        try {
            const data = await this.redis.get(`maxProgress:${postId}`);
            return data ? parseFloat(data) : 30; // Default to 30% (starting point)
        } catch (error) {
            logger.error(`Failed to get max progress for ${postId}:`, error);
            return 30;
        }
    }

    async setMaxProgress(postId, percentage) {
        try {
            await this.redis.setex(
                `maxProgress:${postId}`,
                24 * 60 * 60, // 24 hours
                percentage.toString()
            );
            return true;
        } catch (error) {
            logger.error(`Failed to set max progress for ${postId}:`, error);
            return false;
        }
    }

    async updateProgress(postId, progressData) {
        try {
            // Store progress with expiration (24 hours)
            await this.redis.setex(
                `progress:${postId}`,
                24 * 60 * 60, // 24 hours
                JSON.stringify({
                    ...progressData,
                    updatedAt: new Date().toISOString()
                })
            );
            return true;
        } catch (error) {
            logger.error(`Failed to update progress for ${postId}:`, error);
            return false;
        }
    }

    async deleteProgress(postId) {
        try {
            await this.redis.del(`progress:${postId}`);
            return true;
        } catch (error) {
            logger.error(`Failed to delete progress for ${postId}:`, error);
            return false;
        }
    }

    async getCompletedMedia(postId) {
        try {
            const data = await this.redis.get(`completed:${postId}`);
            return data ? JSON.parse(data) : [];
        } catch (error) {
            logger.error(`Failed to get completed media for ${postId}:`, error);
            return [];
        }
    }

    async markMediaCompleted(postId, mediaId) {
        try {
            const completed = await this.getCompletedMedia(postId);
            if (!completed.includes(mediaId)) {
                completed.push(mediaId);
                await this.redis.setex(
                    `completed:${postId}`,
                    24 * 60 * 60,
                    JSON.stringify(completed)
                );
            }
            return true;
        } catch (error) {
            logger.error(`Failed to mark media ${mediaId} as completed:`, error);
            return false;
        }
    }

    async isMediaCompleted(postId, mediaId) {
        try {
            const completed = await this.getCompletedMedia(postId);
            return completed.includes(mediaId);
        } catch (error) {
            logger.error(`Failed to check if media ${mediaId} is completed:`, error);
            return false;
        }
    }

    async getMediaResult(postId, mediaId) {
        try {
            const data = await this.redis.get(`mediaResult:${postId}:${mediaId}`);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            logger.error(`Failed to get media result for ${postId}:${mediaId}:`, error);
            return null;
        }
    }

    async setMediaResult(postId, mediaId, result) {
        try {
            await this.redis.setex(
                `mediaResult:${postId}:${mediaId}`,
                24 * 60 * 60, // 24 hours
                JSON.stringify(result)
            );
            return true;
        } catch (error) {
            logger.error(`Failed to set media result for ${postId}:${mediaId}:`, error);
            return false;
        }
    }

    async getAllMediaResults(postId) {
        try {
            const completed = await this.getCompletedMedia(postId);
            const results = [];
            for (const mediaId of completed) {
                const result = await this.getMediaResult(postId, mediaId);
                if (result) {
                    results.push(result);
                }
            }
            return results;
        } catch (error) {
            logger.error(`Failed to get all media results for ${postId}:`, error);
            return [];
        }
    }

    async clearPostData(postId) {
        try {
            const completed = await this.getCompletedMedia(postId);
            // Delete all media result keys
            for (const mediaId of completed) {
                await this.redis.del(`mediaResult:${postId}:${mediaId}`);
            }
            await this.redis.del(`progress:${postId}`);
            await this.redis.del(`completed:${postId}`);
            await this.redis.del(`maxProgress:${postId}`);
            return true;
        } catch (error) {
            logger.error(`Failed to clear data for ${postId}:`, error);
            return false;
        }
    }
}

module.exports = new ProgressTracker();