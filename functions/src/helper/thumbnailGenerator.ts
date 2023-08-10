import ffmpeg from 'fluent-ffmpeg'
import os from 'os'
import path from 'path';
import fs from 'fs';
import { getStorage, getDownloadURL } from "firebase-admin/storage";
import * as admin from "firebase-admin"

export const createThumbnail = async (videoURL: string, filename: string): Promise<string> => {
  const cloudStorageFolder = 'instagram-thumbnails/'
  const cloudStorageFilePath = cloudStorageFolder + filename

  // Check if thumbnail image already exists in cloud storage
  const existInStorage = await getStorage().bucket().file(cloudStorageFilePath).exists()

  // If it does not exist, create it
  // Firebase returns a multi array result. Since we assume there should only be one image per filename, we will only take the first result to determine if the file exist of not
  if (existInStorage[0] === false) {
    // Create thumbnail image from video URL
    const localThumbnailFilePath = await createThumbnailImage(videoURL, filename)
  
    // Upload thumbnail image to Firebase Storage folder called 'instagram-thumbnails'
    await saveImageToCloudStorage(localThumbnailFilePath, cloudStorageFilePath)
  }

  // Get download URL for the thumbnail image
  const thumbnailDownloadURL = await downloadURL(cloudStorageFilePath)
  return thumbnailDownloadURL
}

const createThumbnailImage = async (videoURL: string, newFileName: string): Promise<string> => {
  const thumbnailFileName = newFileName + '.jpg'
  const localThumbFilePath = path.join(os.tmpdir(), thumbnailFileName)
  await takeScreenshot(videoURL, thumbnailFileName)
  if (!fs.existsSync(localThumbFilePath)) throw "Failed to locate generated file"
  return localThumbFilePath
}

async function takeScreenshot(videoURL: string, newFileName: string) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoURL)
      .on("filenames", (filenames) => {})
      .on("end", () => {
        resolve(null);
      })
      .on("error", (error) => {
        reject(`Failed to take screenshot for thumbnail for ${videoURL}. The error was ${error}`);
      })
      .takeScreenshots(
        {
          count: 1,
          timemarks: ['0'],
          filename: newFileName
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
