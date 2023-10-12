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

export const createOrGetVideoData = async (videoURL: string, filename: string): Promise<VideoData> => {
  // Create cloud storage file path
  const cloudStorageFolder = 'instagram-thumbnails/'
  const cloudStorageFilePath = cloudStorageFolder + filename

  // Check if thumbnail image already exists in cloud storage
  const existInStorage = await getStorage().bucket().file(cloudStorageFilePath).exists()

  // If it does not exist, create a thumbnail image and upload it to cloud storage
  // Firebase returns a multi array result. Since we assume there should only be one image per filename, we will only take the first result to determine if the file exist of not
  if (existInStorage[0] === false) {
    // Save video locally
    const localVideoFilePath =  await saveVideoToLocal(videoURL, filename)

    // Create thumbnail image from video URL and return the local thumbnail file path
    const localThumbnailFilePath = await createThumbnailImage(filename, localVideoFilePath)

    // Get video duration in seconds
    const data = await getVideoMetadata(localVideoFilePath)
    const durationInSeconds = Math.round(data.durationInSeconds)
  
    // Upload thumbnail image and metadata to Firebase Storage
    await saveImageToCloudStorage(localThumbnailFilePath, cloudStorageFilePath, durationInSeconds)

    // Delete local files
    deleteLocalFiles([localThumbnailFilePath, localVideoFilePath])
  }

  // Get thumbnail download URL and video duration
  const videoData = await getVideoDataFromCloud(cloudStorageFilePath)
  return videoData
}

const saveVideoToLocal = async (videoURL: string, filename: string): Promise<string> => {
  try {
    // Create local file path for the video to be stored temporarily
    const localVideoFilePath = path.join(os.tmpdir(), filename + '.mp4')
  
    // Download video from URL and save it locally
    const response = await axios.get(videoURL, {responseType: 'arraybuffer'})
    const videoBuffer = Buffer.from(response.data)
    fs.writeFileSync(localVideoFilePath, videoBuffer)
  
    // Check if video exists in local file storage
    if (!fs.existsSync(localVideoFilePath)) throw "Failed to locate video stored in local file storage"
    return localVideoFilePath
  } catch (error) {
    console.log(`Failed to save video to local file storage. Error was due to ${error}`)
    throw new Error(`Failed to save video to local file storage`)
  }
}

const deleteLocalFiles = (filePaths: string[]) => {
  filePaths.forEach(filePath => {
    fs.unlinkSync(filePath)
  })
}

const createThumbnailImage = async (filename: string, localVideoFilePath: string): Promise<string> => {
  try {
    // Create local file path for the thumbnail image to be stored temporarily
    const localThumbnailFilePath = path.join(os.tmpdir(), filename + '.jpg')
  
    // Create thumbnail image from video
    await takeScreenshot(localVideoFilePath, filename)
  
    // Check if thumbnail image exists in local file storage
    if (!fs.existsSync(localThumbnailFilePath)) throw "Failed to locate generated file"
    return localThumbnailFilePath
  } catch (error) {
    console.log(`Failed to create thumbnail image. Error was due to ${error}`)
    throw new Error(`Failed to create thumbnail image`)
  }
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
  // Save image and metadata to Firebase Storage
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
    console.log(`Failed to upload thumbnail to cloud storage. Error was due to ${error}`)
    throw new Error(`Failed to upload thumbnail to cloud storage`)
  }
}

const getVideoDataFromCloud = async (cloudStorageFilePath: string): Promise<VideoData> => {
  try {
    const fileRef = getStorage().bucket().file(cloudStorageFilePath)
    const downloadURL= await getDownloadURL(fileRef)
    const metadata = await fileRef.getMetadata()
    const durationInSeconds = metadata[0].metadata['durationInSeconds']
    return { thumbnailDownloadURL: downloadURL, durationInSeconds: durationInSeconds }
  } catch (error) {
    console.log(`Failed to get thumbnail image and metadata from cloud storage. Error was due to ${error}`)
    throw new Error(`Failed to get thumbnail image and metadata from cloud storage`)
  }
}
