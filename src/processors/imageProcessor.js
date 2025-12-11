const FFmpeg = require("../utils/ffmpeg");
const mediaUploader = require("../utils/mediaUploader");
const axios = require('axios');
const path = require("path");
const fs = require("fs/promises");

async function processImage(
    localFilePath, 
    outputPath, 
    filename, 
    mediaId, 
    originalName, 
    s3Key,
    progressCallback = null
) {
    let processedImagePath = null;
    let blurredThumbnailPath = null;

    try {
        // Report initial progress
        if (progressCallback) progressCallback(10); // Starting processing
        
        // Process the main image (resize if needed)
        processedImagePath = await FFmpeg.transcodeImage(localFilePath, outputPath, filename);
        
        if (progressCallback) progressCallback(50); // Image processed
        
    } catch (imageError) {
        console.error(`Failed to process image ${filename}:`, imageError.message);
        throw imageError;
    }

    try {
        // Generate blurred thumbnail
        blurredThumbnailPath = await FFmpeg.generateBlurredThumbnail(localFilePath, outputPath, filename);
        
        if (progressCallback) progressCallback(70); // Thumbnail generated
        
    } catch (blurredError) {
        console.warn(`Failed to generate blurred thumbnail for ${filename}:`, blurredError.message);
    }
    
    // Copy the local file to output directory
    const originalFilePath = path.join(outputPath, filename);
    await fs.copyFile(localFilePath, originalFilePath);

    if (progressCallback) progressCallback(80); // Files ready for upload

    // Upload processed files
    const uploadedFiles = await mediaUploader.uploadDirectory(
        outputPath,
        `creator-platform-bucket/${s3Key}processed`
    );
    
    if (progressCallback) progressCallback(100); // Upload complete
    
    // Find processed image URL
    const processedImageFile = uploadedFiles.find(file =>
        file.originalName.includes('_processed')
    );

    // Find blurred thumbnail URL
    const blurredThumbnailFile = uploadedFiles.find(file =>
        file.originalName.includes('_blurred_thumbnail.jpg')
    );

    const originalFile = uploadedFiles.find(file =>
        file.originalName === filename
    );

    // Store result for this image media item
    return {
        mediaId,
        originalName,
        filename,
        mediaType: 'IMAGE',
        status: 'success',
        originalUrl: originalFile?.url || null,
        imageUrl: processedImageFile?.url || null,
        blurredThumbnailUrl: blurredThumbnailFile?.url || null
    };
}

module.exports = { processImage };