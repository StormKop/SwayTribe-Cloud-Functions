import os from 'os'
import path from 'path';
import fs from 'fs';
import { getStorage, getDownloadURL } from "firebase-admin/storage";
import * as admin from "firebase-admin"
import axios from 'axios';
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path
import ffmpeg from 'fluent-ffmpeg'
ffmpeg.setFfmpegPath(ffmpegPath)

export const createThumbnail = async (videoURL: string, filename: string): Promise<string> => {
  // Create cloud storage file path
  const cloudStorageFolder = 'instagram-thumbnails/'
  const cloudStorageFilePath = cloudStorageFolder + filename

  // Check if thumbnail image already exists in cloud storage
  const existInStorage = await getStorage().bucket().file(cloudStorageFilePath).exists()

  // If it does not exist, create a thumbnail image and upload it to cloud storage
  // Firebase returns a multi array result. Since we assume there should only be one image per filename, we will only take the first result to determine if the file exist of not
  if (existInStorage[0] === false) {
    // Create thumbnail image from video URL and return the local thumbnail file path
    const localThumbnailFilePath = await createThumbnailImage(videoURL, filename)
  
    // Upload thumbnail image to Firebase Storage
    await saveImageToCloudStorage(localThumbnailFilePath, cloudStorageFilePath)

    // Delete local files
    fs.unlinkSync(localThumbnailFilePath)
  }

  // Get download URL for the thumbnail image
  const thumbnailDownloadURL = await downloadURL(cloudStorageFilePath)
  return thumbnailDownloadURL
}

const createThumbnailImage = async (videoURL: string, filename: string): Promise<string> => {
  // Create local file path for the video and thumbnail image to be stored temporarily
  const localVideoFilePath =  path.join(os.tmpdir(), filename + '.mp4')
  const localThumbnailFilePath = path.join(os.tmpdir(), filename + '.jpg')

  // Download video from URL and save it locally
  const response = await axios.get(videoURL, {responseType: 'arraybuffer'})
  const videoBuffer = Buffer.from(response.data)
  fs.writeFileSync(localVideoFilePath, videoBuffer)

  // Create thumbnail image from video
  await takeScreenshot(localVideoFilePath, filename)

  // Delete local video file
  fs.unlinkSync(localVideoFilePath)

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

const saveImageToCloudStorage = async (localThumbnailFilePath: string, destinationFilePath: string) => {
  try {
    const bucket = admin.storage().bucket()
    const response = await bucket.upload(localThumbnailFilePath, {
      destination: destinationFilePath,
      metadata: {
        contentType: 'image/jpg',
      },
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
