import os from 'os'
import path from 'path';
import fs from 'fs';
import { getStorage, getDownloadURL } from "firebase-admin/storage";
import * as admin from "firebase-admin"
import axios from 'axios';
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path
import ffmpeg from 'fluent-ffmpeg'
import { getVideoMetadata } from '@remotion/renderer';
ffmpeg.setFfmpegPath(ffmpegPath)

type VideoData = {
  thumbnailDownloadURL: string,
  durationInSeconds: number
}

export const createThumbnail = async (videoURL: string, filename: string): Promise<VideoData> => {
  // Create cloud storage file path
  const cloudStorageFolder = 'instagram-thumbnails/'
  const cloudStorageFilePath = cloudStorageFolder + filename
  const localVideoFilePath =  path.join(os.tmpdir(), filename + '.mp4')

  // Check if thumbnail image already exists in cloud storage
  const existInStorage = await getStorage().bucket().file(cloudStorageFilePath).exists()

  // If it does not exist, create a thumbnail image and upload it to cloud storage
  // Firebase returns a multi array result. Since we assume there should only be one image per filename, we will only take the first result to determine if the file exist of not
  if (existInStorage[0] === false) {
    // Create thumbnail image from video URL and return the local thumbnail file path
    const localThumbnailFilePath = await createThumbnailImage(videoURL, filename, localVideoFilePath)

    // Get video duration in seconds
    const data = await getVideoMetadata(localVideoFilePath)
    const durationInSeconds = Math.round(data.durationInSeconds)
  
    // Upload thumbnail image to Firebase Storage
    await saveImageToCloudStorage(localThumbnailFilePath, cloudStorageFilePath, durationInSeconds)

    // Delete local files
    fs.unlinkSync(localThumbnailFilePath)
    fs.unlinkSync(localVideoFilePath)
  }

  // Get download URL for the thumbnail image
  const thumbnailDownloadURL = await downloadURL(cloudStorageFilePath)
  const metadata = await getStorage().bucket().file(cloudStorageFilePath).getMetadata()
  const durationInSeconds = metadata[0].metadata['videoDurationInSeconds']
  return { thumbnailDownloadURL, durationInSeconds }
}

const createThumbnailImage = async (videoURL: string, filename: string, localVideoFilePath: string): Promise<string> => {
  // Create local file path for the video and thumbnail image to be stored temporarily
  const localThumbnailFilePath = path.join(os.tmpdir(), filename + '.jpg')

  // Download video from URL and save it locally
  const response = await axios.get(videoURL, {responseType: 'arraybuffer'})
  const videoBuffer = Buffer.from(response.data)
  fs.writeFileSync(localVideoFilePath, videoBuffer)

  // Create thumbnail image from video
  await takeScreenshot(localVideoFilePath, filename)

  if (!fs.existsSync(localThumbnailFilePath)) throw "Failed to locate generated file"
  return localThumbnailFilePath
}

async function takeScreenshot(videoFilePath: string, filename: string) {
  return new Promise((resolve, reject) => {
     ffmpeg({ source: videoFilePath })
        .on("filenames", (filenames) => {})
        .on("end", () => {
           resolve(null);
        })
        .on("error", (error) => {
           console.error(error);
           reject(error);
        })
        .takeScreenshots(
           {
              count: 1,
              timestamps: [0], //in seconds
              filename: filename + ".jpg",
           },
           os.tmpdir()
        )
  });
}

const saveImageToCloudStorage = async (localThumbnailFilePath: string, destinationFilePath: string, durationInSeconds: number) => {
  try {
    const bucket = admin.storage().bucket()
    const response = await bucket.upload(localThumbnailFilePath, {
      destination: destinationFilePath,
      metadata: {
        contentType: 'image/jpg',
        metadata: {
          durationInSeconds: durationInSeconds
        }
      }
    })

    return response
  } catch (error) {
    throw new Error(`Failed to upload thumbnail to cloud storage. Error was due to ${error}`)
  }
}

const downloadURL = async (cloudStorageFilePath: string): Promise<string> => {
  try {
    const fileRef = getStorage().bucket().file(cloudStorageFilePath)
    const downloadURL= await getDownloadURL(fileRef)
    return downloadURL
  } catch (error) {
    throw new Error(`Failed to get download URL from cloud storage for thumbnail. Error was due to ${error}`)
  }
}
