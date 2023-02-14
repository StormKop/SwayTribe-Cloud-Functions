import { auth, https, logger } from "firebase-functions";
import * as admin from "firebase-admin"

admin.initializeApp()

export const createUser = auth.user().onCreate((user) => {
  const uid = user.uid
  const email = user.email
  const createdAt = user.metadata.creationTime
  const updatedAt = user.metadata.creationTime

  const userRef = admin.firestore().collection("users").doc(uid)
  return userRef.create({
    email: email,
    createdAt: createdAt,
    updatedAt: updatedAt
  })
})

export const saveUserAccessToken = https.onCall(async (data, context) => {
  // Check if user is authenticated else return an error
  if (!context.auth) {
    throw new https.HttpsError('unauthenticated', 'User not authenticated')
  }
  const uid = context.auth.uid
  
  // Check if any data is given
  const access_token = data.access_token as string
  const token_type = data.token_type as number

  try {
    // Save Instagram User Access Token - short lived
    const userRef = admin.firestore().collection("users").doc(uid)
    
    return userRef.update({
      access_token_ig: access_token,
      access_token_type_ig: token_type
    })
  } catch (error) {
    logger.log(error)
    throw new https.HttpsError('internal', 'Internal error')
  }
})