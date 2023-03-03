import { auth, https, logger, runWith } from "firebase-functions";
import * as admin from "firebase-admin"
import { SetOptions } from "firebase-admin/firestore";
import { isValidGetRequest, isValidPostRequest, isValidRedirectUrl } from "./helper/canva-signature-helper";
import QueryString from "qs";
import axios from "axios";
import { environment } from "./helper/helper";

admin.initializeApp()

export const createUser = auth.user().onCreate((user) => {
  const uid = user.uid
  const email = user.email

  const userRef = admin.firestore().collection("users").doc(uid)
  return userRef.create({
    email: email,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
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
      access_token_type_ig: token_type,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
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
          await userDoc.set({
            canvaUserId: canvaUserId,
            canvaBrandIds: [canvaBrandId],
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, mergeOptions)
          return {success: true, state: canvaState}
        } else {
          await userDoc.set({
            canvaUserId: canvaUserId,
            canvaBrandIds: admin.firestore.FieldValue.arrayUnion(canvaBrandId),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, mergeOptions)
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
    if(!isValidPostRequest(canva_secret, req, '/isUserLinkedToCanva')) {
      res.status(401).send({type: 'FAIL', message: 'Failed signature test'})
      return
    }
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
    if(!isValidPostRequest(canva_secret, req, req.path)) {
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
        await doc.ref.update({
          canvaUserId: '', 
          canvaBrandIds: [],
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        })
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
  const currentEnvironment = environment()
  if (currentEnvironment === 'DEV') {
    res.status(302).redirect(`http://localhost:3000/authenticate/canva?${stringifiedParams}`)
    return
  } else if (currentEnvironment === 'PROD') {
    res.status(200).redirect(`https://www.swaytribe.com/authenticate/canva?${stringifiedParams}`)
  } else {
    res.status(401).send({type: 'FAIL', message: 'Invalid environment'})
  }
})

export const canvaGetAllInstagramAccounts = runWith({secrets: ['CANVA_SECRET']}).https.onRequest(async (req, res) => {

  const canva_secret = process.env.CANVA_SECRET
  if(canva_secret === undefined) {
    res.status(401).send({type: 'FAIL', message: 'Secret key not found'})
    return
  }

  if (req.method === 'GET') {
    if(!isValidGetRequest(canva_secret, req, '/canvaGetAllInstagramAccounts')) {
      res.status(401).send({type: 'FAIL', message: 'Failed signature test'})
      return
    }
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
      res.status(200).send({type: 'FAIL', message: 'There are no Canva users matching this request'})
      return
    } else {
      // Log any cases where there are more than one user with the same canvaUserId and canvaBrandId
      if(snapshot.docs.length > 1) {
        console.log(`There are multiple users with the same canva user ID ${canvaUserId}`)
        res.status(200).send({type: 'FAIL', message: 'There are multiple accounts tied to this Canva user'})
      } else {
        snapshot.docs.forEach(async (doc: admin.firestore.DocumentData) => {
          const accessToken = doc.data().access_token_ig
          const response = await axios.get(`https://graph.facebook.com/v15.0/me/accounts?fields=instagram_business_account%7Bid%2Cname%2Cusername%2Cfollowers_count%2Cprofile_picture_url%7D&access_token=${accessToken}`);
          const accounts = response.data.data.map((account: any) => ({
            'id': account.instagram_business_account.id,
            'name': account.instagram_business_account.name,
            'username': account.instagram_business_account.username,
            'followers': account.instagram_business_account.followers_count,
            'profile_picture_url': account.instagram_business_account.profile_picture_url
          }))
          res.status(200).send({type: 'SUCCESS', data: accounts})
        })
      }
    }
  } catch (error) {
    // Return error if any
    console.log(`Error getting all user Instagram account for Canva`, error)
    res.status(500).send({error: 'Error getting all user Instagram account for Canva'})
    return
  }
})

export const getBusinessAccountDetails = runWith({secrets: ['CANVA_SECRET']}).https.onRequest(async (req, res) => {

  const canva_secret = process.env.CANVA_SECRET
  if(canva_secret === undefined) {
    res.status(401).send({type: 'FAIL', message: 'Secret key not found'})
    return
  }

  if (req.method === 'GET') {
    if(!isValidGetRequest(canva_secret, req, '/getBusinessAccountDetails')) {
      res.status(401).send({type: 'FAIL', message: 'Failed signature test'})
      return
    }
  } else {
    res.status(401).send({type: 'FAIL', message: 'Invalid request method type'})
    return
  }

  const canvaUserId = req.header('X-Canva-User-Id')
  const canvaBrandId = req.header('X-Canva-Brand-Id')
  const businessProfileName = req.query.profileName
  const requesterPageId = req.query.requesterPageId

  if (canvaUserId === undefined || canvaBrandId === undefined || businessProfileName === undefined || requesterPageId === undefined) {
    res.status(200).send({type: "FAIL", message: "Missing request header or body"})
    return
  }

  try {
    //Check if the requesting Canva User ID is linked to an existing SwayTribe account
    const userRef = admin.firestore().collection("users")
    const snapshot = await userRef.where('canvaUserId', '==', canvaUserId).where('canvaBrandIds','array-contains',canvaBrandId).get()

    if(snapshot.empty) {
      // Return false if there is not user linked
      console.log(`There are no Canva users that match canva user ID ${canvaUserId} and brand ID ${canvaBrandId}`)
      res.status(200).send({type: 'FAIL', message: 'There are no Canva users matching this request'})
      return
    } else {
      // Log any cases where there are more than one user with the same canvaUserId and canvaBrandId
      if(snapshot.docs.length > 1) {
        console.log(`There are multiple users with the same canva user ID ${canvaUserId}`)
        res.status(200).send({type: 'FAIL', message: 'There are multiple accounts tied to this Canva user'})
      } else {
        snapshot.docs.forEach(async (doc: admin.firestore.DocumentData) => {
          const accessToken = doc.data().access_token_ig
          const response = await axios.get(`https://graph.facebook.com/v15.0/${requesterPageId}?fields=business_discovery.username(${businessProfileName})%7Bfollowers_count%2Cmedia_count%2Cbiography%2Cname%2Cusername%2Cfollows_count%2Cwebsite%2Cprofile_picture_url%7D&access_token=${accessToken}`);
          const business_discovery = response.data.business_discovery
          const result = {
            'id': business_discovery.id,
            'profile_picture_url': business_discovery.profile_picture_url,
            'properties': [
              {'property': 'username', 'title': 'Username', 'value': business_discovery.username},
              {'property': 'name', 'title': 'Profile Name', 'value': business_discovery.name},
              {'property': 'followers', 'title': 'Total followers', 'value': business_discovery.followers_count},
              {'property': 'following', 'title': 'Total following', 'value': business_discovery.follows_count},
              {'property': 'biography', 'title': 'Biography', 'value': business_discovery.biography},
              {'property': 'website', 'title': 'Website', 'value': business_discovery.website},
              {'property': 'media_count', 'title': 'Total posts', 'value': business_discovery.media_count}
            ]
          }
          res.status(200).send({type: 'SUCCESS', data: result})
        })
      }
    }
  } catch (error) {
    // Return error if any
    // Need to show IG based errors since they have details on things like username is not valid
    console.log(`Error getting business account details`, error)
    res.status(500).send({error: `Error getting business account details for ${businessProfileName}`})
    return
  }
})

// Get's all the users Instagram accounts that will be shown in the website /dashboard
export const getAllInstagramAccounts = https.onCall(async (data, context) => {

  // Check if user is authenticated else return an error
  if (!context.auth) {
    throw new https.HttpsError('unauthenticated', 'User not authenticated.')
  }

  // Get user UID
  const uid = context.auth.uid

  try {
    // Get users document from Firestore
    const userRefDoc = admin.firestore().collection("users").doc(uid)
    const snapshot = await userRefDoc.get()

    // Check if the document exist
    if(!snapshot.exists) {
      // Return false if there is not user linked
      console.log(`There are no SwayTribe users that match the incoming ${uid}`)
      throw new https.HttpsError('not-found', 'User is not found.')
    } else {
      // Get the document data
      const data = snapshot.data()
      // Return an error of document is empty, this likely means the user is not created or the onCreate user data did not work
      if (data === undefined) {
        throw new https.HttpsError('not-found', 'There is no data found for this user')
      } else {
        // Get the users IG access token from the Firestore document data
        const accessToken = data.access_token_ig
        // Make a call to IG to get all of the users IG accounts
        const response = await axios.get(`https://graph.facebook.com/v15.0/me/accounts?fields=instagram_business_account%7Bid%2Cname%2Cusername%2Cfollowers_count%2Cprofile_picture_url%7D&access_token=${accessToken}`);
        // Loop through the results and create an array of IG accounts
        const accounts = response.data.data.map((account: any) => ({
          'id': account.instagram_business_account.id,
          'name': account.instagram_business_account.name,
          'username': account.instagram_business_account.username,
          'followers': account.instagram_business_account.followers_count,
          'profile_picture_url': account.instagram_business_account.profile_picture_url
        }))
        // Return the IG accounts for consumption on the client side
        return accounts        
      }
    }
  } catch (error) {
    // Return error if any
    console.log(`Error getting all user Instagram account for SwayTribe`, error)
    throw new https.HttpsError('unknown', 'Error getting all user Instagram account for SwayTribe')
  }
})