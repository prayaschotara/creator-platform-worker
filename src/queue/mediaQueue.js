/* eslint-disable esm/no-commonjs */
const { Worker } = require('bullmq');
const fs = require("fs/promises");
const winston = require('winston');
const path = require("path");
const s3Client = require('../utils/s3Client');
const imageProcessor = require("../processors/imageProcessor")
const videoProcessor = require("../processors/videoProcessor");
const progressTracker = require('../utils/progressTracker');

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'logs/queue.log' })
    ]
});

const CONFIG = {
    OUTPUT_DIR: path.join(__dirname, "../output"),
    DOWNLOAD_DIR: path.join(__dirname, "../downloads"),
    MAX_CONCURRENT_JOBS: parseInt(process.env.WORKER_CONCURRENCY),
    REDIS_URL: process.env.REDIS_URL || 'rediss://default:ATgHAAIncDI3ZDI4ODRiYzEzMzI0Y2MyOGY4NDEwYWZhNTQwZGFmOXAyMTQzNDM@select-boxer-14343.upstash.io:6379',
};

// Create queue
const mediaQueue = new Worker('media-processing', async (job) => {
    const { postId, media, s3Key, userId, callbackUrl } = job.data;

    logger.info(`Processing media job`, {
        s3Key,
        jobId: job.id,
        postId,
        mediaCount: media.length,
        userId,
        callbackUrl
    });

    try {
        // Get the maximum progress ever reached (persists across retries)
        const maxProgress = await progressTracker.getMaxProgress(postId);
        
        let progress = Math.max(30, maxProgress); // Start from max progress or 30% minimum
        const totalMedia = media.length
        const progressPerMedia = 70 / totalMedia; // Divide remaining 70% among media and steps
        const mediaProgress = new Array(totalMedia).fill(0);
        
        logger.info(`Starting job for post ${postId}, maximum progress: ${maxProgress}%, current attempt: ${job.attemptsMade + 1}`);

        const updateProgress = async (message, extraProgress = 0, mediaIndex = null) => {
            if (mediaIndex !== null && extraProgress > 0) {
                // Update specific media progress
                mediaProgress[mediaIndex] = Math.min(progressPerMedia, mediaProgress[mediaIndex] + extraProgress);
            }

            const mediaTotalProgress = mediaProgress.reduce((sum, p) => sum + p, 0);
            const calculatedProgress = Math.min(95, 30 + mediaTotalProgress);
            
            // Get current maximum progress
            const currentMaxProgress = await progressTracker.getMaxProgress(postId);
            
            // Only update progress if it exceeds the maximum ever reached
            // This prevents progress from going backwards on retries
            if (calculatedProgress > currentMaxProgress) {
                progress = calculatedProgress;
                // Update the maximum progress
                await progressTracker.setMaxProgress(postId, progress);
                logger.debug(`Progress increased to ${progress}% (exceeds previous max of ${currentMaxProgress}%)`);
            } else {
                // Keep progress at maximum, don't go backwards
                progress = currentMaxProgress;
                logger.debug(`Progress stayed at ${progress}% (calculated: ${calculatedProgress}%, max: ${currentMaxProgress}%)`);
            }

            await job.updateProgress({
                percentage: Math.round(progress),
                message: message,
                postId: postId,
                timestamp: new Date().toISOString(),
                currentMedia: mediaIndex !== null ? mediaIndex + 1 : null,
                totalMedia: totalMedia
            });

            // Persist progress to Redis for retry resilience
            try {
                await progressTracker.updateProgress(postId, {
                    percentage: Math.round(progress),
                    message: message,
                    currentMedia: mediaIndex !== null ? mediaIndex + 1 : null,
                    totalMedia: totalMedia,
                    maxProgress: currentMaxProgress
                });
            } catch (trackerError) {
                logger.warn('Failed to persist progress to tracker:', trackerError.message);
            }

            if (callbackUrl) {
                try {
                    const { notifyPrimaryServer } = require('../app');
                    await notifyPrimaryServer(callbackUrl, {
                        postId,
                        progress: Math.round(progress),
                        message: message,
                        attempt: job.attemptsMade + 1,
                        status: 'processing',
                        type: 'progress',
                        currentMedia: mediaIndex !== null ? mediaIndex + 1 : null,
                        totalMedia: totalMedia
                    });
                } catch (notifyError) {
                    logger.warn('Failed to notify progress:', notifyError.message);
                }
            }
        };

        // Restore progress for already completed media items
        const existingProgress = await progressTracker.getProgress(postId);
        const completedMediaIds = await progressTracker.getCompletedMedia(postId);
        
        // Restore media progress based on completed items
        let completedCount = 0;
        for (let i = 0; i < media.length; i++) {
            if (completedMediaIds.includes(media[i].id)) {
                mediaProgress[i] = progressPerMedia; // Mark as fully completed
                completedCount++;
            }
        }
        
        if (completedCount > 0) {
            const restoredProgress = 30 + (mediaProgress.reduce((sum, p) => sum + p, 0));
            progress = Math.max(progress, restoredProgress);
            logger.info(`Restored ${completedCount} completed media items for post ${postId}, progress: ${progress}%`);
        }
        
        // Ensure we start from the maximum progress ever reached
        const finalMaxProgress = await progressTracker.getMaxProgress(postId);
        if (finalMaxProgress > progress) {
            progress = finalMaxProgress;
            logger.info(`Starting from maximum progress: ${finalMaxProgress}% for post ${postId}`);
        }
        
        // Process all media items in the job
        const processedMediaResults = new Array(totalMedia).fill(null);
        
        // Restore results from previously completed media items in correct order
        const existingResults = await progressTracker.getAllMediaResults(postId);
        const resultMap = new Map(existingResults.map(r => [r.mediaId, r]));
        for (let i = 0; i < media.length; i++) {
            const result = resultMap.get(media[i].id);
            if (result) {
                processedMediaResults[i] = result;
            }
        }
        
        await fs.mkdir(CONFIG.DOWNLOAD_DIR, { recursive: true });
        await fs.mkdir(CONFIG.OUTPUT_DIR, { recursive: true });
        const localOutputPath = path.join(CONFIG.OUTPUT_DIR, postId);
        const localDownloadPath = path.join(CONFIG.DOWNLOAD_DIR, postId);

        await updateProgress('Starting media processing...');

        for (const [index, mediaItem] of media.entries()) {
            const { id: mediaId, type: mediaType, filename, originalName, height } = mediaItem;

            // Check if this media item was already completed in a previous attempt
            const isCompleted = await progressTracker.isMediaCompleted(postId, mediaId);
            if (isCompleted) {
                logger.info(`Skipping already completed media: ${mediaId} (${filename})`);
                // Progress for this media item is already restored, just log the skip
                await updateProgress(`Skipping already completed: ${filename}`, 0, index);
                continue;
            }

            await updateProgress(`Processing ${index + 1}/${media.length}: ${filename}`, 0, index);

            // Create a clean directory for each media item
            const mediaOutputPath = path.join(localOutputPath, mediaId);
            const mediadownloadPath = path.join(CONFIG.DOWNLOAD_DIR, mediaId);
            await fs.rm(mediaOutputPath, { recursive: true, force: true });
            await fs.mkdir(mediaOutputPath, { recursive: true });
            await fs.rm(mediadownloadPath, { recursive: true, force: true });
            await fs.mkdir(mediadownloadPath, { recursive: true });
            const fullS3Key = `creator-platform-bucket/${s3Key}original/${filename}`

            const mediaJobData = {
                postId,
                mediaId,
                s3Key: fullS3Key,
                originalName,
                userId,
                filename,
                localOutputPath: mediaOutputPath,
                url: `${process.env.DO_SPACES_ENDPOINT}/creator-platform-bucket/${s3Key}original/${filename}`
            };

            const signedUrl = (await s3Client.getSignedUrlForRead(mediaJobData.s3Key)).toString();
            await s3Client.downloadFromUrl(signedUrl, localDownloadPath);
            await updateProgress(`Downloaded ${filename}`, progressPerMedia * 0.1, index);

            logger.info(`Processing individual media item`, {
                jobId: job.id,
                mediaId,
                mediaType,
                filename
            });

            if (mediaType === 'VIDEO') {
                await updateProgress(`Transcoding video: ${filename}`, 0, index);
                // Pass progress callback to video processor
                const videoProgressCallback = (videoProgress) => {
                    // Video transcoding gets 70% of media progress (from 10% to 80% of media progress)
                    const videoProgressAmount = (progressPerMedia * 0.7) * (videoProgress / 100);
                    updateProgress(`Transcoding video: ${filename} (${Math.round(videoProgress)}%)`, videoProgressAmount, index);
                };
                
                const result = await videoProcessor.processVideo(
                    localDownloadPath,
                    mediaOutputPath,
                    filename,
                    height,
                    mediaId,
                    originalName,
                    s3Key,
                    videoProgressCallback
                );
                if (result) {
                    processedMediaResults[index] = result;
                    // Mark media as completed and store result for retry resilience
                    await progressTracker.markMediaCompleted(postId, mediaId);
                    await progressTracker.setMediaResult(postId, mediaId, result);
                }
                await updateProgress(`Video transcoding completed: ${filename}`, progressPerMedia * 0.2, index);
            } else if (mediaType === 'IMAGE') {
                await updateProgress(`Processing image: ${filename}`, 0, index);

                const result = await imageProcessor.processImage(
                    localDownloadPath,
                    mediaOutputPath,
                    filename,
                    mediaId,
                    originalName,
                    s3Key
                );
                if (result) {
                    processedMediaResults[index] = result;
                    // Mark media as completed and store result for retry resilience
                    await progressTracker.markMediaCompleted(postId, mediaId);
                    await progressTracker.setMediaResult(postId, mediaId, result);
                }
                await updateProgress(`Image processing completed: ${filename}`, progressPerMedia * 0.9, index);
            }
        }
        await updateProgress('Uploading processed files...');
        // Clean up local files
        await fs.rm(localOutputPath, { recursive: true, force: true });
        await fs.rm(localDownloadPath, { recursive: true, force: true });
        await updateProgress('Finalizing...', 5); // Final 5%
        
        // Set progress to 100% on successful completion
        await progressTracker.setMaxProgress(postId, 100);
        progress = 100;
        
        // Filter out null values (media items that weren't processed)
        const validResults = processedMediaResults.filter(r => r !== null);
        
        // Notify primary server with ALL results at once
        if (callbackUrl && validResults.length > 0) {
            const { notifyPrimaryServer } = require('../app');
            await notifyPrimaryServer(callbackUrl, {
                postId,
                mediaResults: validResults, // Send all media results
                totalProcessed: validResults.length,
                attempt: job.attemptsMade + 1,
                status: 'success',
                progress: 100,
                message: 'Media processing completed successfully'
            });
        }

        logger.info(`All media processing completed successfully for post: ${postId}`, {
            totalProcessed: validResults.length
        });

        return {
            postId,
            mediaResults: validResults,
            totalProcessed: validResults.length,
            status: 'success'
        };

    } catch (error) {
        logger.error(`Media processing failed`, {
            jobId: job.id,
            postId,
            error: error.message,
            stack: error.stack
        });

        // Update progress to indicate failure, but preserve maximum progress
        try {
            const currentMaxProgress = await progressTracker.getMaxProgress(postId);
            await job.updateProgress({
                percentage: Math.round(currentMaxProgress), // Keep at max progress, don't reset
                message: `Processing failed: ${error.message}`,
                status: 'failed',
                postId: postId,
                timestamp: new Date().toISOString()
            });
            // Persist the current progress (at max) even on failure
            await progressTracker.updateProgress(postId, {
                percentage: Math.round(currentMaxProgress),
                message: `Processing failed: ${error.message}`,
                status: 'failed'
            });
        } catch (progressError) {
            logger.warn('Failed to update progress on error:', progressError.message);
        }

        // Clean up on error
        try {
            const localOutputPath = path.join(CONFIG.OUTPUT_DIR, postId);
            await fs.rm(localOutputPath, { recursive: true, force: true });
            const localDownloadPath = path.join(CONFIG.DOWNLOAD_DIR, postId);
            await fs.rm(localDownloadPath, { recursive: true, force: true });
        } catch (cleanupError) {
            logger.warn('Failed to cleanup local files:', cleanupError.message);
        }

        // Notify primary server of failure
        if (callbackUrl) {
            try {
                const currentMaxProgress = await progressTracker.getMaxProgress(postId);
                const { notifyPrimaryServer } = require('../app');
                await notifyPrimaryServer(callbackUrl, {
                    postId,
                    error: error.message,
                    attempt: job.attemptsMade + 1,
                    status: 'failed',
                    progress: Math.round(currentMaxProgress), // Use max progress, not 100%
                    message: `Processing failed: ${error.message}`
                });
            } catch (notifyError) {
                logger.error('Failed to notify primary server of error:', notifyError);
            }
        }
        throw error;
    }
}, {
    connection: {
        url: CONFIG.REDIS_URL
    },
    defaultJobOptions: {
        removeOnComplete: 50,
        removeOnFail: 100,
        attempts: 1,
        backoff: {
            type: 'exponential',
            delay: 5000,
        },
    },
    concurrency: CONFIG.MAX_CONCURRENT_JOBS,
    removeOnComplete: 50,
    removeOnFail: 100,
    settings: {
        stalledInterval: 30 * 1000, // 30 seconds
        maxStalledCount: 1,
        retryProcessDelay: 5 * 1000, // 5 seconds
    }
});

const cleanupWorker = new Worker('cleanup-queue', async (job) => {
    if (job.name === 'cleanup-failed-media') {
        const { postId, s3Key, media } = job.data;

        logger.info(`Processing media cleanup`, {
            jobId: job.id,
            postId,
            mediaCount: media.length
        });

        try {
            // Attempt to delete files from S3
            for (const mediaItem of media) {
                const fileKey = `${s3Key}${mediaItem.filename}`;
                try {
                    // await s3Client.deleteFile(fileKey);
                    logger.info(`Cleaned up original file: ${fileKey}`);
                } catch (deleteError) {
                    logger.warn(`Failed to delete original file ${fileKey}:`, deleteError.message);
                }
            }

            logger.info(`Successfully completed cleanup for post: ${postId}`);
            return { success: true };

        } catch (error) {
            logger.error(`Failed to cleanup post ${postId}:`, error);
            throw error;
        }
    }
}, {
    connection: {
        url: CONFIG.REDIS_URL
    },
    concurrency: 1
});

// Queue event handlers
mediaQueue.on('completed', (job, result) => {
    logger.info(`Job completed`, {
        jobId: job.id,
        type: job.name,
        processingTime: Date.now() - job.processedOn
    });
});

mediaQueue.on('failed', (job, err) => {
    logger.error(`Job failed`, {
        jobId: job.id,
        type: job.name,
        error: err.message,
        attempts: job.attemptsMade
    });
});

mediaQueue.on('stalled', (job) => {
    logger.warn(`Job stalled`, {
        jobId: job.id,
        type: job.name
    });
});

mediaQueue.on('progress', (job, progress) => {
    logger.debug(`Job progress`, {
        jobId: job.id,
        type: job.name,
        progress: `${progress}%`
    });
});

// Cleanup function
async function cleanup() {
    logger.info('Cleaning up queue resources...');
    await mediaQueue.close();
    await cleanupWorker.close();
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

logger.info('Media queue processor started and listening for jobs...');

module.exports = { mediaQueue, cleanupWorker };