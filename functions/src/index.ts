import { auth, https, logger, runWith } from "firebase-functions";
import * as admin from "firebase-admin"
import { SetOptions } from "firebase-admin/firestore";
import { isValidPostRequest, isValidRedirectUrl } from "./helper/canva-helper";
import { isValidPostRequest, isValidRedirectUrl } from "./helper/canva-signature-helper";
import QueryString from "qs";

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

export const linkUserToCanva = https.onCall(async (data, context) => {
  const canvaSignatures = data.signatures
  const canvaBrandId = data.brand
  const canvaState = data.state
  const canvaUserId = data.user
  const canvaTime = data.time
  
  // Check if user is authenticated else return an error
  if (!context.auth) {
    return {success: false, state: canvaState, error: 'User not authenticated'}
  }

  const uid = context.auth.uid

  if (canvaUserId === undefined || canvaBrandId === undefined || canvaSignatures === undefined || canvaState === undefined || canvaTime === undefined) {
    return {success: false, state: canvaState, error: 'Missing request body'}
  }
  
  try {
    //Check if the requesting Canva User ID is linked to an existing SwayTribe account
    const userDoc = admin.firestore().collection("users").doc(uid)
    const snapshot = await userDoc.get()
    const mergeOptions: SetOptions = { merge: true} 

    if(!snapshot.exists) {
      // Return false if there is not user linked
      console.log(`There are no SwayTribe user that match this user ID ${uid}`)
      return {success: false, state: canvaState, error: 'User not found in SwayTribe'}
    } else {
      const data = snapshot.data()
      if(data !== undefined) {
        if (data.canvaBrandIds === undefined) {
          await userDoc.set({canvaUserId: canvaUserId, canvaBrandIds: [canvaBrandId]}, mergeOptions)
          return {success: true, state: canvaState}
        } else {
          await userDoc.set({canvaUserId: canvaUserId, canvaBrandIds: admin.firestore.FieldValue.arrayUnion(canvaBrandId)}, mergeOptions)
          return {success: true, state: canvaState}
        }
      } else {
        console.log(`There are no SwayTribe user that match this user ID ${uid}`)
        return {success: false, state: canvaState, error: 'User not found in SwayTribe'}
      }
    }
  } catch (error) {
    // Return error if any
    console.log(`Error linking Canva user to SwayTribe account`, error)
    return {success: false, state: canvaState, error: 'Error linking Canva user to SwayTribe account'}
  }
})

export const isUserLinkedToCanva = runWith({secrets: ['CANVA_SECRET']}).https.onRequest(async (req, res) => {

  const canva_secret = process.env.CANVA_SECRET
  if(canva_secret === undefined) {
    res.status(401).send({type: 'FAIL', message: 'Secret key not found'})
    return
  }

  if (req.method === 'POST') {
  //   if(!isValidPostRequest(canva_secret, req)) {
  //     res.status(401).send({type: 'FAIL', message: 'Failed signature test'})
  //     return
    // }
  } else {
    res.status(401).send({type: 'FAIL', message: 'Invalid request method type'})
    return
  }
  
  const canvaUserId = req.header('X-Canva-User-Id')
  const canvaBrandId = req.header('X-Canva-Brand-Id')

  if (canvaUserId === undefined || canvaBrandId === undefined) {
    res.status(200).send({type: "FAIL", message: "Missing request body"})
    return
  }
  
  try {
    //Check if the requesting Canva User ID is linked to an existing SwayTribe account
    const userRef = admin.firestore().collection("users")
    const snapshot = await userRef.where('canvaUserId', '==', canvaUserId).where('canvaBrandIds','array-contains',canvaBrandId).get()

    if(snapshot.empty) {
      // Return false if there is not user linked
      console.log(`There are no Canva users that match canva user ID ${canvaUserId} and brand ID ${canvaBrandId}`)
      res.status(200).send({isAuthenticated: false})
      return
    } else {
      // Log any cases where there are more than one user with the same canvaUserId and canvaBrandId
      if(snapshot.docs.length > 1) {
        console.log(`There are multiple users with the same canva user ID ${canvaUserId}`)
      }
      // Return true if this canvaUserId is already to a SwayTribe account
      res.status(200).send({isAuthenticated: true})
      return
    }
  } catch (error) {
    // Return error if any
    console.log(`Error checking if Canva user to SwayTribe account`, error)
    res.status(500).send({error: 'Error checking if Canva user is a SwayTribe user'})
    return
  }
})

export const unlinkUserFromCanva = runWith({secrets: ['CANVA_SECRET']}).https.onRequest(async (req, res) => {

  const canva_secret = process.env.CANVA_SECRET
  if(canva_secret === undefined) {
    res.status(401).send({type: 'FAIL', message: 'Secret key not found'})
    return
  }

  if (req.method === 'POST') {
    if(!isValidPostRequest(canva_secret, req)) {
      res.status(401).send({type: 'FAIL', message: 'Failed signature test'})
      return
    }
  } else {
    res.status(401).send({type: 'FAIL', message: 'Invalid request method type'})
    return
  }

  const canvaUserId: string = req.body.user
  const canvaBrandId: string = req.body.brand

  if (!req.url.includes('/configuration/delete')) {
    res.status(200).send({type: "FAIL", message: "This is not a valid URL for this trigger"})
    return
  }

  if (canvaUserId === undefined && canvaBrandId === undefined) {
    res.status(200).send({type: "FAIL", message: "Missing request body"})
    return
  }

  try {
    //Find Swaytribe user for Canva user ID
    const userRef = admin.firestore().collection("users")
    const snapshot = await userRef.where('canvaUserId', '==', canvaUserId).where('canvaBrandIds','array-contains',canvaBrandId).get()

    if(snapshot.empty) {
      // Return success if snapshot is empty, ideally this should not happen since a user should be using this link via Canva only
      console.log(`No Swaytribe user found for Canva user ID ${canvaUserId}`)
      res.status(200).send({type: "SUCCESS"})
      return
    } else {
      if (snapshot.docs.length > 1) {
        // Log any cases where there are more than one user with the same canvaUserId and canvaBrandId
        console.log(`There are multiple users with the same canva user ID ${canvaUserId}`)
      }

      //TODO: This should only unlink the user from the one brand ID only!!!
      snapshot.docs.forEach( async (doc) => {
        // Unlink all Canva identifiers from this user
        await doc.ref.update({canvaUserId: '', canvaBrandIds: []})
      })

      // Return success if Swaytribe user is successfully unlinked from Canva
      res.status(200).send({type: "SUCCESS"})
      return
    }

  } catch (error) {
    // Return error if any
    console.log(error)
    res.status(500).send({error: 'Error unlinking Canva user from SwayTribe'})
    return
  }
})

export const redirectCanvaToSwayTribe = runWith({secrets: ['CANVA_SECRET']}).https.onRequest(async (req, res) => {

  const canva_secret = process.env.CANVA_SECRET
  if(canva_secret === undefined) {
    res.status(401).send({type: 'FAIL', message: 'Secret key not found'})
    return
  }

  if (req.method === 'GET') {
    if(!isValidRedirectUrl(canva_secret, req)) {
      res.status(401).send({type: 'FAIL', message: 'Failed signature test'})
      return
    }
  } else {
    res.status(401).send({type: 'FAIL', message: 'Invalid request method type'})
    return
  }
  
  const stringifiedParams = QueryString.stringify(req.query)
  if (process.env.FUNCTIONS_EMULATOR == 'true') {
    res.status(302).redirect(`http://localhost:3000/authenticate/canva?${stringifiedParams}`)
    return
  } else {
    res.status(200).redirect(`https://www.swaytribe.com/authenticate/canva?${stringifiedParams}`)
  }
})
})