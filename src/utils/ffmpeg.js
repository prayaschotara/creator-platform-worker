const { spawn } = require('child_process');
const path = require('path');
const fs = require("fs/promises");
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

class FFmpegService {

  generateThumbnail(inputPath, outputDir, filename, timeOffset = "00:00:01") {
    return new Promise((resolve, reject) => {
      const thumbnailPath = path.join(outputDir, `${filename.split('.')[0]}_thumbnail.jpg`);

      const ffmpegArgs = [
        "-i",
        inputPath,
        "-ss",
        timeOffset,
        "-vframes",
        "1",
        "-vf",
        "scale=320:180", // 16:9 aspect ratio thumbnail
        "-q:v",
        "2", // High quality
        "-y", // Overwrite output files
        thumbnailPath
      ];

      const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

      let stderrData = "";

      ffmpegProcess.stdout.on("data", (data) => {
        logger.info(`FFmpeg thumbnail stdout: ${data}`);
      });

      ffmpegProcess.stderr.on("data", (data) => {
        stderrData += data.toString();
        const message = data.toString();
        if (message.includes("error") || message.includes("Error")) {
          console.error(`FFmpeg thumbnail error: ${message}`);
        }
      });

      ffmpegProcess.on("close", (code) => {
        if (code === 0) {
          logger.info(`Successfully generated thumbnail: ${thumbnailPath}`);
          resolve(thumbnailPath);
        } else {
          console.error(`FFmpeg thumbnail failed with code ${code}`);
          console.error(`Full stderr output: ${stderrData}`);
          reject(new Error(`FFmpeg thumbnail exited with code ${code}`));
        }
      });

      ffmpegProcess.on("error", (err) => {
        console.error(`Thumbnail process error:`, err);
        reject(err);
      });
    });
  }

  transcodeSingleRendition(inputPath, outputDir, rendition, filename, progressCallback = null) {
    return new Promise((resolve, reject) => {
      const ffmpegArgs = [
        "-i",
        inputPath,
        "-hide_banner",
        "-y",
        // Video settings
        "-vf",
        `scale=w=-2:h=${rendition.height}`,
        "-c:v",
        "h264",
        "-profile:v",
        "main",
        "-crf",
        "20",
        "-g",
        "48",
        "-keyint_min",
        "48",
        "-b:v",
        rendition.videoBitrate,
        "-maxrate",
        rendition.maxrate,
        "-bufsize",
        rendition.bufsize,
        // Audio settings
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-b:a",
        rendition.audioBitrate,
        // HLS settings
        "-f",
        "hls",
        "-hls_time",
        "4",
        "-hls_playlist_type",
        "vod",
        "-hls_segment_filename",
        path.join(outputDir, `${filename.split('.')[0]}_${rendition.name}_%03d.ts`),
        path.join(outputDir, `${filename.split('.')[0]}_${rendition.name}.m3u8`),
      ];

      const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

      let stderrData = "";
      let duration = null;

      ffmpegProcess.stdout.on("data", (data) => {
        logger.info(`FFmpeg stdout (${rendition.name}): ${data}`);
      });

      ffmpegProcess.stderr.on("data", (data) => {
        stderrData += data.toString();
        // Only log important stderr messages
        const message = data.toString();
        if (!duration && message.includes('Duration:')) {
          const durationMatch = message.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
          if (durationMatch) {
            const hours = parseInt(durationMatch[1]);
            const minutes = parseInt(durationMatch[2]);
            const seconds = parseFloat(durationMatch[3]);
            duration = hours * 3600 + minutes * 60 + seconds;
          }
        }

         // Extract current time and calculate progress
         if (duration && message.includes('time=')) {
          const timeMatch = message.match(/time=(\d+):(\d+):(\d+\.\d+)/);
          if (timeMatch && progressCallback) {
            const hours = parseInt(timeMatch[1]);
            const minutes = parseInt(timeMatch[2]);
            const seconds = parseFloat(timeMatch[3]);
            const currentTime = hours * 3600 + minutes * 60 + seconds;
            const progress = Math.min(100, (currentTime / duration) * 100);
            
            progressCallback(progress);
          }
        }

         // Only log important stderr messages
         if (message.includes("frame=") || message.includes("time=") || message.includes("speed=")) {
          // Progress messages - you can uncomment if you want to see progress
          // logger.info(`FFmpeg progress (${rendition.name}): ${message.trim()}`);
        } else if (message.includes("error") || message.includes("Error")) {
          logger.error(`FFmpeg error (${rendition.name}): ${message}`);
        }
      });

      ffmpegProcess.on("close", (code) => {
        if (code === 0) {
          logger.info(`Successfully transcoded ${rendition.name}`);
          resolve();
        } else {
          logger.error(`FFmpeg failed for ${rendition.name} with code ${code}`);
          logger.error(`Full stderr output: ${stderrData}`);
          reject(
            new Error(`FFmpeg exited with code ${code} for ${rendition.name}`)
          );
        }
      });

      ffmpegProcess.on("error", (err) => {
        logger.error(`Process error for ${rendition.name}:`, err);
        reject(err);
      });
    });
  }

  async createMasterPlaylist(renditions, outputDir, filename) {
    let masterContent = "#EXTM3U\n#EXT-X-VERSION:3\n\n";

    for (const rendition of renditions) {
      try {
        // Extract bandwidth from bitrate strings like "1000k" -> 1000000
        const videoBitrateNum =
          parseInt(rendition.videoBitrate.replace(/k$/i, "")) * 1000;
        const audioBitrateNum =
          parseInt(rendition.audioBitrate.replace(/k$/i, "")) * 1000;
        const totalBandwidth = videoBitrateNum + audioBitrateNum;

        // Calculate width based on height (assuming 16:9 aspect ratio)
        const width = Math.round((rendition.height * 16) / 9);

        masterContent += `#EXT-X-STREAM-INF:BANDWIDTH=${totalBandwidth},RESOLUTION=${width}x${rendition.height},NAME="${rendition.name}"\n`;
        masterContent += `${filename + '_' + rendition.name}.m3u8\n\n`;
      } catch (error) {
        logger.error(`Error processing rendition ${rendition.name}:`, error);
        throw error;
      }
    }

    const masterPath = path.join(outputDir, `${filename}_master.m3u8`);
    await fs.writeFile(masterPath, masterContent, "utf8");

    logger.info("Master playlist content:");
    logger.info(masterContent);

    return masterPath;
  }

  generateBlurredThumbnail(inputPath, outputDir, filename) {
    return new Promise((resolve, reject) => {
        const blurredThumbnailPath = path.join(outputDir, `${filename.split('.')[0]}_blurred_thumbnail.jpg`);
        
        const ffmpegArgs = [
            "-i",
            inputPath,
            "-vf",
            "scale=320:240:force_original_aspect_ratio=decrease,boxblur=10:1", // Scale down and apply blur
            "-q:v",
            "5", // Lower quality for thumbnail
            "-y", // Overwrite output files
            blurredThumbnailPath
        ];

        logger.info(`FFmpeg blurred thumbnail command:`, ffmpegArgs.join(" "));

        const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

        let stderrData = "";

        ffmpegProcess.stdout.on("data", (data) => {
          logger.info(`FFmpeg blurred thumbnail stdout: ${data}`);
        });

        ffmpegProcess.stderr.on("data", (data) => {
            stderrData += data.toString();
            const message = data.toString();
            if (message.includes("error") || message.includes("Error")) {
              logger.error(`FFmpeg blurred thumbnail error: ${message}`);
            }
        });

        ffmpegProcess.on("close", (code) => {
            if (code === 0) {
              logger.info(`Successfully generated blurred thumbnail: ${blurredThumbnailPath}`);
                resolve(blurredThumbnailPath);
            } else {
                logger.error(`FFmpeg blurred thumbnail failed with code ${code}`);
                logger.error(`Full stderr output: ${stderrData}`);
                reject(new Error(`FFmpeg blurred thumbnail exited with code ${code}`));
            }
        });

        ffmpegProcess.on("error", (err) => {
            logger.error(`Blurred thumbnail process error:`, err);
            reject(err);
        });
    });
  }

  transcodeImage(inputPath, outputDir, filename) {
    return new Promise((resolve, reject) => {
      const processedImagePath = path.join(outputDir, `${filename.split('.')[0]}_processed${path.extname(filename)}`);
      
      const ffmpegArgs = [
          "-i",
          inputPath,
          "-vf",
          "scale=1920:1080:force_original_aspect_ratio=decrease", // Max 1080p while maintaining aspect ratio
          "-q:v",
          "2", // High quality
          "-y", // Overwrite output files
          processedImagePath
      ];

      const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

      let stderrData = "";

      ffmpegProcess.stdout.on("data", (data) => {
          logger.info(`FFmpeg image processing stdout: ${data}`);
      });

      ffmpegProcess.stderr.on("data", (data) => {
          stderrData += data.toString();
          const message = data.toString();
          if (message.includes("error") || message.includes("Error")) {
              logger.error(`FFmpeg image processing error: ${message}`);
          }
      });

      ffmpegProcess.on("close", (code) => {
          if (code === 0) {
              logger.info(`Successfully processed image: ${processedImagePath}`);
              resolve(processedImagePath);
          } else {
              logger.error(`FFmpeg image processing failed with code ${code}`);
              logger.error(`Full stderr output: ${stderrData}`);
              reject(new Error(`FFmpeg image processing exited with code ${code}`));
          }
      });

      ffmpegProcess.on("error", (err) => {
          logger.error(`Image processing error:`, err);
          reject(err);
      });
  });
  }
}

module.exports = new FFmpegService();