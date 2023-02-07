import * as functions from "firebase-functions";
import * as admin from "firebase-admin"

admin.initializeApp()

export const createUser = functions.auth.user().onCreate((user) => {
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
