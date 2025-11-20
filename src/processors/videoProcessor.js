const winston = require('winston');
const FFmpeg = require("../utils/ffmpeg")
const mediaUploader = require("../utils/mediaUploader")

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.simple(),
    transports: [new winston.transports.Console()]
});
const RENDITIONS = [
    {
        height: 480,
        name: "480p",
        videoBitrate: "800k",
        maxrate: "856k",
        bufsize: "1200k",
        audioBitrate: "96k",
    },
    {
        height: 720,
        name: "720p",
        videoBitrate: "2800k",
        maxrate: "2996k",
        bufsize: "4200k",
        audioBitrate: "128k",
    },
    {
        height: 1080,
        name: "1080p",
        videoBitrate: "5000k",
        maxrate: "5350k",
        bufsize: "7500k",
        audioBitrate: "192k",
    },
    {
        height: 2160,
        name: "2160p",
        videoBitrate: "15000k",
        maxrate: "16050k",
        bufsize: "22500k",
        audioBitrate: "320k",
    },
];

async function processVideo(localFilePath, outputPath, filename, height, mediaId, originalName, s3Key, progressCallback = null) {
    const targetRenditions = RENDITIONS.filter(
        (r) => r.height <= height
    );
    if (targetRenditions.length === 0) {
        targetRenditions.push(RENDITIONS[0]);
    }
    // Generate thumbnail first
    let thumbnailPath = null;
    try {
        thumbnailPath = await FFmpeg.generateThumbnail(localFilePath, outputPath, filename);
        logger.info(`Generated thumbnail: ${thumbnailPath}`);
    } catch (thumbnailError) {
        logger.warn(`Failed to generate thumbnail for ${filename}:`, thumbnailError.message);
    }

    const totalRenditions = targetRenditions.length;
    let completedRenditions = 0;
    // Process video renditions
    for (const rendition of targetRenditions) {
        logger.info(`Starting transcoding for ${rendition.name}`);
        await FFmpeg.transcodeSingleRendition(localFilePath, outputPath, rendition, filename, (progress) => {
            if (progressCallback) {
                const renditionProgress = (completedRenditions + (progress / 100));
                const overallVideoProgress = renditionProgress * 100;
                progressCallback(overallVideoProgress)
            }
        });
        completedRenditions++; 
        logger.info(`Completed transcoding for ${rendition.name}`);
        if(progressCallback) {
            const overallVideoProgress = (completedRenditions / totalRenditions) * 100;
            progressCallback(overallVideoProgress);
        }
    }

    // Create master playlist
    const masterPath = await FFmpeg.createMasterPlaylist(
        targetRenditions,
        outputPath,
        filename.split('.')[0]
    );

    if (masterPath) {
        // Upload all files and get their paths
        const uploadedFiles = await mediaUploader.uploadDirectory(
            outputPath, 
            `creator-platform-bucket/${s3Key}processed`
        );
        
        // Find the master playlist URL
        const masterPlaylistFile = uploadedFiles.find(file => 
            file.originalName.includes('_master.m3u8')
        );
        
        // Find thumbnail URL
        const thumbnailFile = uploadedFiles.find(file => 
            file.originalName.includes('_thumbnail.jpg')
        );

        // Store result for this media item
        return {
            mediaId,
            originalName,
            filename,
            mediaType: 'VIDEO',
            status: 'success',
            masterPlaylistUrl: masterPlaylistFile?.url || null,
            thumbnailUrl: thumbnailFile?.url || null
        };
    }
}   

module.exports = { processVideo };