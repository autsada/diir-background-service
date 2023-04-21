import * as functions from "firebase-functions"
import vision from "@google-cloud/vision"
import path from "path"
import os from "os"
import { mkdirp } from "mkdirp"
import { promisify } from "util"
import fs from "fs"

import { minInstances, rawBucket } from "."

const logger = functions.logger
const REPLACEMENT_IMAGE_FILE_PATH = "prohibited.png"

/**
 * Process images uploaded to cloud functions
 * 1. Delete the uploaded image that is flagged as Adult or Violence.
 * 2. Resize the image.
 */
export const processImages = functions
  .runWith({
    minInstances,
    maxInstances: 100,
    // Ensure the function has enough memory and time
    // to process large files
    timeoutSeconds: 300,
    memory: "1GB",
  })
  .storage.object()
  .onFinalize(async (obj) => {
    try {
      // Get a path of the file.
      const filePath = obj.name

      // Check if the file exists.
      if (!filePath) {
        logger.log("Object not found")
        return null
      }

      // Get content type
      const contentType = obj.contentType
      if (!contentType?.startsWith("image/")) {
        logger.log("Only format images")
        return null
      }

      /**
       * Check if the image content is adult or violence using Vision API.
       * */
      const isDetected = await imageSafeSearchDetection(
        `gs://${obj.bucket}/${filePath}`
      )

      if (isDetected) {
        logger.log("Adult or violent content detected")
        // Delete the image.
        await rawBucket.file(filePath).delete()

        // Replace the deleted image with the image that shows prohibited sign
        // Construct temp file path to save the replacement image to
        const tempFilePath = path.join(os.tmpdir(), filePath)
        // Get the temp dir name from the file path
        const tempFileDir = path.dirname(tempFilePath)
        // Create the temp dir where the replacement image will be downloaded to.
        await mkdirp(tempFileDir)
        // Download the replacement image to the temp dir
        const replacementFile = rawBucket.file(REPLACEMENT_IMAGE_FILE_PATH)
        await replacementFile.download({ destination: tempFilePath })
        logger.log(
          "The replacement file has been downloaded to: ",
          tempFilePath
        )
        // Upload the replacment image back to the deleted file path
        await rawBucket.upload(tempFilePath, {
          destination: filePath,
          resumable: true,
        })
        logger.log("Uploaded the replacement file to: ", filePath)

        // Unlink the downloaded replacement file to free up space
        const unlink = promisify(fs.unlink)
        await unlink(tempFilePath)
        logger.log("Unlinked the downloaded file from: ", tempFilePath)
      }

      logger.log("Processing image finished")
      return null
    } catch (error) {
      logger.error(error)
      throw error
    }
  })

// Detect adult or violence content
async function imageSafeSearchDetection(gcsUri: string) {
  // Creates a vision client.
  const visionClient = new vision.ImageAnnotatorClient()

  // Performs safe search property detection on the file.
  const [result] = await visionClient.safeSearchDetection(gcsUri)

  const detections = result.safeSearchAnnotation
  const adultContent =
    detections?.adult === "POSSIBLE" ||
    detections?.adult === "LIKELY" ||
    detections?.adult === "VERY_LIKELY"
  const violenceContent =
    detections?.violence === "POSSIBLE" ||
    detections?.violence === "LIKELY" ||
    detections?.violence === "VERY_LIKELY"

  return adultContent || violenceContent
}
