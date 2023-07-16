import { auth, https, runWith } from "firebase-functions";
import * as admin from "firebase-admin"
import { SetOptions } from "firebase-admin/firestore";
import axios from "axios";
import { environment } from "./helper/helper";
import cors from 'cors';
import { createJwtMiddleware, ExtendedFirebaseRequest, getTokenFromQueryString } from "./helper/canva_jwt_verification";
import { FieldValue } from '@google-cloud/firestore'
import dotenv from 'dotenv';
import Stripe from "stripe";

dotenv.config();
admin.initializeApp()
const corsHandler = cors({ origin: ['https://app-aafqj9tmlb4.canva-apps.com'] });
const jwtMiddleware = createJwtMiddleware()

export const sendSupportEmail = https.onCall(async (data, context) => {
  // const name = data.name
  // const message = data.message

  if (!context.auth) {
    throw new https.HttpsError('unauthenticated', 'User not authenticated')
  }

  return {success: true}
})

export const createUser = auth.user().onCreate(async (user) => {
  const uid = user.uid
  const email = user.email

  const userRef = admin.firestore().collection("users").doc(uid)
  return userRef.create({
    email: email,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  })
})

export const getSubscriptionStatus = https.onCall(async (_data, context) => {
  // Check if user is authenticated and retrieve the user ID
  if (!context.auth) {
    console.log('User not authenticated')
    throw new https.HttpsError('unauthenticated', 'User not authenticated')
  }
  const uid = context.auth.uid

  // Get user details from Firestore
  const userRef = admin.firestore().collection("users").doc(uid)
  const userDoc = await userRef.get()

  // Check if user document exists
  if (!userDoc.exists) {
    console.log(`There are no SwayTribe users that match the incoming ${uid}`)
    throw new https.HttpsError('not-found', 'User not found in database')
  }

  // Check if user document contains any data
  const userData = userDoc.data()
  if (userData === undefined) {
    console.log(`There is no data found for this user ${uid}`)
    throw new https.HttpsError('internal', 'User found in database but user data is missing')
  }

  // Get Stripe subscription status and customer ID
  const stripeSubscriptionStatus = userData.stripeSubscriptionStatus
  const stripeCustomerId = userData.stripeCustomerId

  // Return error if Stripe subscription status or customer ID is not found
  if (stripeCustomerId === undefined || stripeCustomerId === '') {
    return {
      status: 'no-stripe-customer-id'
    }
  } else if (stripeSubscriptionStatus === 'active' || stripeSubscriptionStatus === 'trialing') {
    return {
      status: 'active'
    }
  } else {
    return {
      status: stripeSubscriptionStatus
    }
  }
})

// Add new user to Swaytribe waitlist
export const addToWaitlist = runWith({secrets: ['MAILERLITE_API_KEY']}).https.onCall(async (data, _) => {
  // Get email address
  const email = data.email as string

  // Return error if there is no email addrress or if the email address is just a blank string
  if (email === undefined || email.length === 0) {
    console.log('No email address found')
    throw new https.HttpsError('invalid-argument', 'No email address found')
  }

  //Check if Mailerlite API key is found
  const mailerliteApiKey = process.env.MAILERLITE_API_KEY

  // Return error if Mailerlite API key is not found
  if (mailerliteApiKey === undefined) {
    console.log(`Mailerlite API key not found`)
    throw new https.HttpsError('failed-precondition', 'Mailerlite API key not found')
  }

  // Check if user is already in SwayTribe waitlist
  const subscriberDoc = admin.firestore().collection("subscribers").doc(email)
  const subscribedData = await subscriberDoc.get()

  if(subscribedData.exists === true) {
    // Return error if user is already on the waitlist
    console.log(`User is already on SwayTribe waitlist`)
    throw new https.HttpsError('already-exists', 'User is already on SwayTribe waitlist')
  }

  // Add user to Mailerlite subscriber list
  try {
    await axios.post(`https://connect.mailerlite.com/api/subscribers`, {
      email: email,
      fields: {
        sign_up_email_status: 'pending'
      }
    }, {
      headers: {
        'Authorization': `Bearer ${mailerliteApiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    })
  } catch (error: any) {
    const errorMessage = error.response.data.message
    console.log(errorMessage)
    throw new https.HttpsError('internal', `Failed to add user to Mailerlite: ${errorMessage}`)
  }

  // Add user to waitlist if they are not in the waitlist
  await subscriberDoc.create({
    email: email,
    createdAt: FieldValue.serverTimestamp()
  })

  return {success: true, message: 'User added to waitlist'}
})

export const saveUserAccessToken = runWith({secrets: ['FACEBOOK_CLIENT_ID','FACEBOOK_CLIENT_SECRET']}).https.onCall(async (data, context) => {
  // Check if user is authenticated
  if (!context.auth) {
    console.log('User not authenticated')
    throw new https.HttpsError('unauthenticated', 'User not authenticated')
  }
  const uid = context.auth.uid

  // Get short lived access token from request
  const shortLivedToken = data.access_token as string

  // Return error if there is no email addrress or if the email address is just a blank string
  if (shortLivedToken === undefined || shortLivedToken.length === 0) {
    console.log('Instagram access token not found in request')
    throw new https.HttpsError('invalid-argument', 'Missing Instagram access token in request')
  }

  // Get Facebook client ID and secret from environment variables
  const fbClientId = process.env.FACEBOOK_CLIENT_ID
  const fbClientSecret = process.env.FACEBOOK_CLIENT_SECRET
  
  if(fbClientId === undefined || fbClientSecret === undefined ) {
    console.log('Missing Facebook environment values')
    throw new https.HttpsError('failed-precondition', 'Missing Facebook environment values')
  }
  
  // Convert short lived access token to long lived token
  const longLivedToken = await getLongLivedToken(shortLivedToken, fbClientId, fbClientSecret)
  
  // Save Instagram never expire token to Firestore
  const userRef = admin.firestore().collection("users").doc(uid)
  
  return userRef.update({
    access_token_ig: longLivedToken,
    updatedAt: FieldValue.serverTimestamp()
  })
})

const getLongLivedToken = async (shortLivedToken: string, clientID: string, clientSecret: string) => {
  try {
    const longLivedResponse = await axios.get(`https://graph.facebook.com/v15.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${clientID}&client_secret=${clientSecret}&fb_exchange_token=${shortLivedToken}`)
    const longLivedToken = longLivedResponse.data.access_token
    // BELOW IS THE IMPLEMENTATION FOR NEVER EXPIRE TOKENS
    // TO IMPLEMENT THIS, YOU WILL NEED TO ENSURE TO HAVE A COLLECTION OF ALL THE USERS PAGES
    // WITHIN THESE PAGES, THERE SHOULD BE A PAGE ID AND ACCESS TOKEN
    // WHEN PULLING DATA I.E GETALLINSTAGRAMUSERS() USE THE LONG LIVED ACCESS TOKEN
    // WHEN PULLING DATA FOR A SPECIFIC PAGE, REPLACE ACCOUNTS/ME WITH THE PAGE ID RETRIEVED FROM THE NEVER EXPIRE TOKEN
  
    // const userIdResponse = await axios.get(`https://graph.facebook.com/me?access_token=${longLivedAccessToken}`)
  
    // if (userIdResponse.status !== 200) {
    //   throw new https.HttpsError('unknown', 'Failed to get user ID from long lived access token', userIdResponse.data.error)
    // }
    // const userId = userIdResponse.data.id
  
    // const neverExpireTokenResponse = await axios.get(`https://graph.facebook.com/v15.0/${userId}/accounts?access_token=${longLivedAccessToken}`)
  
    // if (neverExpireTokenResponse.status !== 200) {
    //   throw new https.HttpsError('unknown', 'Failed to get never expire token from long lived access token', neverExpireTokenResponse.data.error)
    // }
  
    // YOU CAN LOOP THROUGH THIS TO GET EACH PAGES ACCESS TOKEN, SAVE THE PAGE ID AND ACCESS TOKEN TO FIRESTORE USERS COLLECTION AS A NEW COLLECTION I.E PAGES
    // const neverExpireToken = neverExpireTokenResponse.data.data[0].access_token
    return longLivedToken
  } catch (error: any) {
    const errorMessage = error.response.data.error.message
    console.log(errorMessage)
    throw new https.HttpsError('unknown', `Failed to get long lived access token from Instagram: ${errorMessage}`)
  }
}

export const linkUserToCanva = https.onCall(async (data, context) => {
  const canvaUserId = data.canvaUserId
  const canvaBrandId = data.canvaBrandId
  const canvaState = data.state
  
  // Check if user is authenticated else return an error
  if (!context.auth) {
    return {success: false, state: canvaState, error: 'User not authenticated'}
  }

  const uid = context.auth.uid

  if (canvaUserId === undefined || canvaBrandId === undefined || canvaState === undefined) {
    return {success: false, state: canvaState, error: 'Missing Canva request body'}
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
    }
    const data = snapshot.data()
    if(data === undefined) {
      console.log(`There are no SwayTribe user that match this user ID ${uid}`)
      return {success: false, state: canvaState, error: 'User not found in SwayTribe'}
    }

    if (data.canvaBrandIds === undefined) {
      await userDoc.set({
        canvaUserId: canvaUserId,
        canvaBrandIds: [canvaBrandId],
        updatedAt: FieldValue.serverTimestamp()
      }, mergeOptions)
      return {success: true, state: canvaState}
    } else {
      await userDoc.set({
        canvaUserId: canvaUserId,
        canvaBrandIds: admin.firestore.FieldValue.arrayUnion(canvaBrandId),
        updatedAt: FieldValue.serverTimestamp()
      }, mergeOptions)
      return {success: true, state: canvaState}
    }
  } catch (error) {
    // Return error if any
    console.log(`Error linking Canva user to SwayTribe account`, error)
    return {success: false, state: canvaState, error: 'Error linking Canva user to SwayTribe account'}
  }
})

export const isUserLinkedToCanva = https.onRequest(async (req, res) => {
  corsHandler(req, res, async () => {
    // Creating a new request object with the Canva user data
    const extendedReq = Object.create(req) as ExtendedFirebaseRequest
    jwtMiddleware(extendedReq, res, async () => {
      // Get Canva user from request
      const user = extendedReq.canva
      try {
        //Check if the requesting Canva User ID is linked to an existing SwayTribe account
        const userRef = admin.firestore().collection("users")
        const snapshot = await userRef.where('canvaUserId', '==', user.userId).where('canvaBrandIds','array-contains',user.brandId).get()

        if(snapshot.empty) {
          // Return false if there is not user linked
          console.log(`There are no Canva users that match canva user ID ${user.userId} and brand ID ${user.brandId}`)
          throw new Error('User not found in SwayTribe')
        }
        // Log any cases where there are more than one user with the same canvaUserId and canvaBrandId
        if(snapshot.docs.length > 1) {
          console.log(`There are multiple users with the same canva user ID ${user.userId}`)
        }
        // Return true if this canvaUserId is already to a SwayTribe account
        res.status(200).send({isAuthenticated: true})
        return
      } catch (error) {
        // Return error if any
        if (error instanceof Error) {
          console.log(error.message)
          res.status(401).send({isAuthenticated: false, message: error.message})
        } else {
          console.log(error)
          res.status(401).send({isAuthenticated: false, message: error})
        }
        return
      }
    })
  })
})

export const unlinkUserFromCanva = https.onRequest(async (req, res) => {
  if (!req.url.includes('/configuration/delete')) {
    console.log(`This is not a valid URL for this trigger`)
    res.status(200).send({type: "FAIL", message: "This is not a valid URL for this trigger"})
    return
  }

  corsHandler(req, res, async () => {
    const extendedReq = Object.create(req) as ExtendedFirebaseRequest
    jwtMiddleware(extendedReq, res, async () => {
      // Get Canva user from request
      const user = extendedReq.canva
      try {
        //Find Swaytribe user for Canva user ID
        const userRef = admin.firestore().collection("users")
        const snapshot = await userRef.where('canvaUserId', '==', user.userId).where('canvaBrandIds','array-contains', user.brandId).get()
    
        // Return success if snapshot is empty, ideally this should not happen since a user should be using this link via Canva only
        if(snapshot.empty) {
          console.log(`No Swaytribe user found for Canva user ID ${user.userId}`)
          throw new Error('No SwayTribe user found for this Canva user')
        }

        // Return fail if there are multiple Swaytribe accounts
        if (snapshot.docs.length > 1) {
          console.log(`There are multiple users with the same canva user ID ${user.userId}`)
          throw new Error('There are multiple SwayTribe users linked to this Canva account')
        }

        // Update Swaytribe user to remove Canva user ID and brand ID
        // TODO: Remove Canva brand ID from array first, if array does not contain any more brand IDs, remove Canva user ID
        const doc = snapshot.docs[0]
        await doc.ref.update({
          canvaUserId: '',
          canvaBrandIds: [],
          updatedAt: FieldValue.serverTimestamp()
        })
  
        // Return success if SwayTribe user is successfully unlinked from Canva
        res.status(200).send({type: "SUCCESS"})
        return
      } catch (error) {
        // Return error if any
        console.log(error)
        res.status(401).send({type: 'FAIL', error: 'Error unlinking Canva user from SwayTribe'})
        return
      }
    })
  })
})

export const redirectCanvaToSwayTribe = https.onRequest(async (req, res) => {
  corsHandler(req, res, async () => {
    // Creating a new request object with the Canva user data
    const extendedReq = Object.create(req) as ExtendedFirebaseRequest
    const redirectJwtMiddleware = createJwtMiddleware(getTokenFromQueryString)
    redirectJwtMiddleware(extendedReq, res, async () => {
      const canvaUserId = extendedReq.canva.userId as string
      const canvaBrandId = extendedReq.canva.brandId as string
      const canvaState = extendedReq.query.state as string

      if(canvaUserId === undefined || canvaBrandId === undefined || state === undefined) {
        res.status(401).send({type: 'FAIL', message: 'Missing Canva user ID, brand ID or state'})
        return
      }
      
      const stringifiedParams = new URLSearchParams({
        canvaUserId: canvaUserId,
        canvaBrandId: canvaBrandId,
        state: canvaState,
      })

      const currentEnvironment = environment()
      if (currentEnvironment === 'DEV') {
        res.status(302).redirect(`http://localhost:3000/authenticate/canva?${stringifiedParams}`)
        return
      } else if (currentEnvironment === 'PROD') {
        res.status(302).redirect(`https://www.swaytribe.com/authenticate/canva?${stringifiedParams}`)
      } else {
        res.status(401).send({type: 'FAIL', message: 'Invalid environment'})
      }
    })
  })
})

export const getBusinessAccountDetails = https.onRequest(async (req, res) => {
  corsHandler(req, res, async () => {
    // Creating a new request object with the Canva user data
    const extendedReq = Object.create(req) as ExtendedFirebaseRequest
    jwtMiddleware(extendedReq, res, async () => {
      try {
        // Verify JWT and get Canva user ID and brand ID
        const user = extendedReq.canva
        const canvaUserId = user.userId
        const canvaBrandId = user.brandId
        const businessProfileName = req.query.profileName
        const requesterPageId = req.query.requesterPageId

        if (canvaUserId === undefined || canvaBrandId === undefined) {
          throw new Error('Missing Canva user ID or brand ID')
        }
    
        // Check if business profile name and requester page ID is given
        if (businessProfileName === undefined || requesterPageId === undefined) {
          throw new Error('Missing request body')
        }
    
        // Check if the requesting Canva User ID is linked to an existing SwayTribe account
        const userRef = admin.firestore().collection("users")
        const snapshot = await userRef.where('canvaUserId', '==', canvaUserId).where('canvaBrandIds','array-contains',canvaBrandId).get()
    
        // Return false if there is not user linked
        if(snapshot.empty) {
          console.log(`There are no Canva users that match canva user ID ${canvaUserId} and brand ID ${canvaBrandId}`)
          throw new Error('No SwayTribe user exist for this Canva user')
        }

        // Check if there are multiple SwayTribe users linked to the same Canva user account
        if(snapshot.docs.length > 1) {
          console.log(`There are multiple users with the same canva user ID ${canvaUserId}`)
          throw new Error('There are multiple SwayTribe users linked to this Canva account')
        }

        // Get the Instagram access token
        const data = snapshot.docs[0].data()
        const accessToken = data.access_token_ig as string

        // const stripeSubscriptionStatus = data.stripeSubscriptionStatus
        // if (stripeSubscriptionStatus !== 'active' || stripeSubscriptionStatus !== 'trialing') {
        //   console.log(`This user does not have an active subscription`)
        //   throw new Error('This user does not have an active subscription')
        // }

        // Check if there is an Instagram access token
        if (accessToken === undefined || accessToken == '') {
          console.log(`This user has not connected their Instagram account to SwayTribe`)
          throw new Error('No Instagram account linked to this SwayTribe user')
        }

        // Get the business account details
        const response = await axios.get(`https://graph.facebook.com/v15.0/${requesterPageId}?fields=business_discovery.username(${businessProfileName})%7Bfollowers_count%2Cmedia_count%2Cbiography%2Cname%2Cusername%2Cfollows_count%2Cwebsite%2Cprofile_picture_url%7D&access_token=${accessToken}`)
        res.status(200).send({type: 'SUCCESS', data: response.data.business_discovery, status: response.status})
        return
      } catch (error) {
        if (error instanceof Error) {
          res.status(401).send({type: 'FAIL', message: error.message})
          return
        }
        
        //TODO: Consider creating a type to manage Axios errors
        let err = error as any
        if ( err.response.data.error.error_user_msg !== undefined) {
          console.log(`Error getting business account details:`, err.response.data.error.error_user_msg);
          res.status(401).send({type: 'FAIL', message: err.response.data.error.error_user_msg})
          return
        }
      }
    })
  })
})

export const canvaGetAllInstagramPages = https.onRequest(async (req, res) => {
  corsHandler(req, res, async () => {
    // Creating a new request object with the Canva user data
    const extendedReq = Object.create(req) as ExtendedFirebaseRequest
    jwtMiddleware(extendedReq, res, async () => {
      try {
        // Get Canva user from request
        const user = extendedReq.canva
        const canvaUserId = user.userId
        const canvaBrandId = user.brandId

        if (canvaUserId === undefined || canvaBrandId === undefined) {
          throw new Error('Missing Canva user ID or brand ID')
        }
        
        // Check if the requesting Canva User ID is linked to an existing SwayTribe account
        const userRef = admin.firestore().collection("users")
        const snapshot = await userRef.where('canvaUserId', '==', canvaUserId).where('canvaBrandIds','array-contains', canvaBrandId).get()
    
        // Return false if there is not user linked
        if(snapshot.empty) {
          console.log(`There are no Canva users that match canva user ID ${canvaUserId} and brand ID ${canvaBrandId}`)
          throw new Error('No SwayTribe user exist for this Canva user')
        }

        // Check if there are multiple SwayTribe users linked to the same Canva user account
        if(snapshot.docs.length > 1) {
          console.log(`There are multiple users with the same canva user ID ${canvaUserId}`)
          throw new Error('There are multiple SwayTribe users linked to this Canva account')
        }

        // Get the Instagram access token
        const data = snapshot.docs[0].data()
        const accessToken = data.access_token_ig as string

        // const stripeSubscriptionStatus = data.stripeSubscriptionStatus
        // if (stripeSubscriptionStatus !== 'active' || stripeSubscriptionStatus !== 'trialing') {
        //   console.log(`This user does not have an active subscription`)
        //   throw new Error('This user does not have an active subscription')
        // }

        // Check if there is an Instagram access token
        if (accessToken === undefined || accessToken == '') {
          console.log(`This user has not connected their Instagram account to SwayTribe`)
          throw new Error('No Instagram account linked to this SwayTribe user')
        }

        // Get all the users Instagram accounts
        const response = await axios.get(`https://graph.facebook.com/v15.0/me/accounts?fields=instagram_business_account%7Bid%2Cname%2Cusername%2Cfollowers_count%2Cprofile_picture_url%7D&access_token=${accessToken}`);
        const accounts = response.data.data.map((account: any) => ({
          'id': account.instagram_business_account.id,
          'name': account.instagram_business_account.name,
          'username': account.instagram_business_account.username,
          'followers': account.instagram_business_account.followers_count,
          'profile_picture_url': account.instagram_business_account.profile_picture_url
        }))
        res.status(200).send({type: 'SUCCESS', data: accounts})
        return
      } catch(error) {
        if (error instanceof Error) {
          res.status(401).send({type: 'FAIL', message: error.message})
          return
        }
        
        //TODO: Consider creating a type to manage Axios errors
        let err = error as any
        if ( err.response.data.error.error_user_msg !== undefined) {
          console.log(`Error getting business account details:`, err.response.data.error.error_user_msg);
          res.status(401).send({type: 'FAIL', message: err.response.data.error.error_user_msg})
          return
        }
      }
    })
  })
})

export const getMediaFromIGUser = https.onRequest(async (req, res) => {
  corsHandler(req, res, async () => {
    // Creating a new request object with the Canva user data
    const extendedReq = Object.create(req) as ExtendedFirebaseRequest
    jwtMiddleware(extendedReq, res, async () => {
      try {
        // Get Canva user from request
        const user = extendedReq.canva
        const canvaUserId = user.userId
        const canvaBrandId = user.brandId
        const businessProfileName = req.query.profileName
        const requesterPageId = req.query.requesterPageId

        if (canvaUserId === undefined || canvaBrandId === undefined) {
          throw new Error('Missing Canva user ID or brand ID')
        }
    
        // Check if business profile name and requester page ID is given
        if (businessProfileName === undefined || requesterPageId === undefined) {
          throw new Error('Missing request body')
        }
        
        // Check if the requesting Canva User ID is linked to an existing SwayTribe account
        const userRef = admin.firestore().collection("users")
        const snapshot = await userRef.where('canvaUserId', '==', canvaUserId).where('canvaBrandIds','array-contains', canvaBrandId).get()
    
        // Return false if there is not user linked
        if(snapshot.empty) {
          console.log(`There are no Canva users that match canva user ID ${canvaUserId} and brand ID ${canvaBrandId}`)
          throw new Error('No SwayTribe user exist for this Canva user')
        }

        // Check if there are multiple SwayTribe users linked to the same Canva user account
        if(snapshot.docs.length > 1) {
          console.log(`There are multiple users with the same canva user ID ${canvaUserId}`)
          throw new Error('There are multiple SwayTribe users linked to this Canva account')
        }

        // Get the Instagram access token
        const data = snapshot.docs[0].data()
        const accessToken = data.access_token_ig as string

        // const stripeSubscriptionStatus = data.stripeSubscriptionStatus
        // if (stripeSubscriptionStatus !== 'active' || stripeSubscriptionStatus !== 'trialing') {
        //   console.log(`This user does not have an active subscription`)
        //   throw new Error('This user does not have an active subscription')
        // }

        // Check if there is an Instagram access token
        if (accessToken === undefined || accessToken == '') {
          console.log(`This user has not connected their Instagram account to SwayTribe`)
          throw new Error('No Instagram account linked to this SwayTribe user')
        }

        // Get all media for this business account search
        const response = await axios.get(`https://graph.facebook.com/v15.0/${requesterPageId}?fields=business_discovery.username(${businessProfileName})%7Bmedia%7Btimestamp%2Cpermalink%2Cmedia_url%2Cmedia_product_type%2C%20media_type%2Ccaption%2Ccomments_count%2Clike_count%7D%7D&access_token=${accessToken}`);
        const business_media = response.data.business_discovery.media
        res.status(200).send({type: 'SUCCESS', data: business_media})
        return
      } catch (error) {
        if (error instanceof Error) {
          res.status(401).send({type: 'FAIL', message: error.message})
          return
        }
        
        //TODO: Consider creating a type to manage Axios errors
        let err = error as any
        if ( err.response.data.error.error_user_msg !== undefined) {
          console.log(`Error getting business account details:`, err.response.data.error.error_user_msg);
          res.status(401).send({type: 'FAIL', message: err.response.data.error.error_user_msg})
          return
        }
      }
    })
  })
})

// Get's all the users Instagram accounts that will be shown in the website /dashboard
export const getAllInstagramAccounts = https.onCall(async (_, context) => {
  // Check if user is authenticated and retrieve the user ID
  if (!context.auth) {
    console.log('User not authenticated')
    throw new https.HttpsError('unauthenticated', 'User not authenticated')
  }
  const uid = context.auth.uid

  // Get user details from Firestore
  const userRef = admin.firestore().collection("users").doc(uid)
  const userDoc = await userRef.get()

  // Check if user document exists
  if (!userDoc.exists) {
    console.log(`There are no SwayTribe users that match the incoming ${uid}`)
    throw new https.HttpsError('not-found', 'User not found in database')
  }

  // Check if user document contains any data
  const userData = userDoc.data()
  if (userData === undefined) {
    console.log(`There is no data found for this user ${uid}`)
    throw new https.HttpsError('internal', 'User found in database but user data is missing')
  }

  // Get the users IG access token from the Firestore document data
  const accessToken = userData.access_token_ig
  if (accessToken === undefined || accessToken === '') {
    console.log('No Instagram access token found for this user. This user has not connected their Instagram account to SwayTribe')
    throw new https.HttpsError('failed-precondition', 'No Instagram account linked to this SwayTribe user')
  }
  
  try {
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
  } catch (error: any) {
    const errorMessage = error.response.data.error.message
    console.log(errorMessage)
    throw new https.HttpsError('unknown', `Failed to get Instagram accounts: ${errorMessage}`)
  }
})

export const stripeWebhook = runWith({secrets: ['STRIPE_TEST_SECRET', 'STRIPE_TEST_WEBHOOK_SECRET', 'STRIPE_SECRET', 'STRIPE_WEBHOOK_SECRET']}).https.onRequest(async (req, res) => {
  // Get Stripe secret key and webhook secret based on environment
  const currentEnvironment = environment()
  const stripeSecret = currentEnvironment === 'PROD' ? process.env.STRIPE_SECRET : process.env.STRIPE_TEST_SECRET
  const stripeWebhookSecret = currentEnvironment === 'PROD' ? process.env.STRIPE_WEBHOOK_SECRET : process.env.STRIPE_TEST_WEBHOOK_SECRET

  // Return an error if Stripe secret or webhook secret is not found
  if (stripeSecret === undefined) {
    res.status(500).json({success: false, error: 'Stripe secret not found'})
    return
  }

  if (stripeWebhookSecret === undefined) {
    res.status(500).json({success: false, error: 'Stripe webhook secret not found'})
    return
  }
  
  // Create a new Stripe instance
  const stripe = new Stripe(stripeSecret, {
    apiVersion: '2022-11-15',
  })

  // Get the event from the request and verify the signature
  const payload = req.rawBody
  const sig = req.headers['stripe-signature'] as string
  const endpointSecret = stripeWebhookSecret

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(payload, sig, endpointSecret) 
  } catch (error) {
    console.log(error)
    res.status(400).json({success: false, error: `Webhook Error: ${error}`})
    return
  }

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
      // Get the subscription object
      const subscription = event.data.object as Stripe.Subscription
      const subscriptionId = subscription.id
      const subscriptionStatus = subscription.status
      // Get the customer email
      const customerId = subscription.customer as string
      const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer
      const customerEmail = customer.email
      // Get the Product details from the Price object in the Subscription object
      const price = subscription.items.data[0].price as Stripe.Price
      const productId = price.product as string
      const product = await stripe.products.retrieve(productId)
      const productName = product.name
      // Get the user role based on the product name -- this will be useful in future when we have more products within the subscription
      let userRole: string
      if (productName === 'Pro') {
        userRole = 'pro'
      } else {
        res.status(400).json({success: false, error: `Product name ${productName} not found. Please check if this product exists in code`})
        return
      }
      // Get the user document from Firestore
      const userSnapshot = admin.firestore().collection('users').where('email', '==', customerEmail)
      const userRef = await userSnapshot.get()
      // Return an error if user is not found
      if (userRef.empty) {
        res.status(400).json({success: false, error: `User with email ${customerEmail} not found`})
        return
      }
      const userDoc = userRef.docs[0]

      // Update the user document with the relevant Stripe subscription details
      await userDoc.ref.update({
        role: userRole,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        stripeSubscriptionStatus: subscriptionStatus,
        updatedAt: FieldValue.serverTimestamp()
      })
    default:
      break
  }
  
  res.json({success: true})
  return
})