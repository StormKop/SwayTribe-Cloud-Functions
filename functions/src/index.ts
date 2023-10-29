import { auth, https, runWith } from "firebase-functions";
import * as admin from "firebase-admin"
import { SetOptions } from "firebase-admin/firestore";
import axios, { AxiosError } from "axios";
import { environment } from "./helper/helper";
import cors from 'cors';
import { createJwtMiddleware, ExtendedFirebaseRequest, getTokenFromQueryString } from "./helper/canva_jwt_verification";
import { FieldValue } from '@google-cloud/firestore'
import dotenv from 'dotenv';
import Stripe from "stripe";
import { sendTelegramMessage } from "./helper/telegram";
import { addWaitlist } from "./helper/mailerlite";
import { createOrGetVideoData } from "./helper/videoProcessor";
import * as crypto from 'crypto';
import cookieParser from "cookie-parser";

dotenv.config();
admin.initializeApp()
const corsHandler = cors({ origin: ['https://app-aafqj9tmlb4.canva-apps.com','https://app-aafdwybelee.canva-apps.com','http://localhost:3000'] });
const jwtMiddleware = createJwtMiddleware()
const cookieParserMiddleware = cookieParser(process.env.CANVA_COOKIE_SECRET)

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

  // Check if user is already in SwayTribe waitlist
  const subscriberDoc = admin.firestore().collection("subscribers").doc(email)
  const subscribedData = await subscriberDoc.get()

  if(subscribedData.exists === true) {
    // Return error if user is already on the waitlist
    console.log(`User is already on SwayTribe waitlist`)
    throw new https.HttpsError('already-exists', 'User is already on SwayTribe waitlist')
  }

  try {
    // Add user to Mailerlite
    await addWaitlist(email)

    // Add user to waitlist in database
    await subscriberDoc.create({
      email: email,
      createdAt: FieldValue.serverTimestamp()
    })

    // Send Telegram message to notify that a new user has been added to the waitlist
    await sendTelegramMessage(`A new user has been added to the waitlist: ${email}`)
  
    return {success: true, message: 'User added to waitlist'}
  } catch (error) {
    if (error instanceof Error) {
      throw new https.HttpsError('unknown', error.message)
    }
    throw new https.HttpsError('unknown', 'Unable to add user to Mailerlite')
  }
})

export const saveUserAccessToken = runWith({secrets: ['FACEBOOK_CLIENT_ID','FACEBOOK_CLIENT_SECRET']}).https.onCall(async (data, context) => {
  // Check if user is authenticated
  if (!context.auth) {
    console.log('User not authenticated')
    throw new https.HttpsError('unauthenticated', 'User not authenticated')
  }
  const uid = context.auth.uid
  const code = data.code as string
  const redirectURI = data.redirectURI as string

  // Return error if there is no Instagram code or redirect URI
  if (code === undefined || code.length === 0 || redirectURI === undefined || redirectURI.length === 0) {
    console.log('Missing required param fields for this request')
    throw new https.HttpsError('invalid-argument', 'Missing required param fields for this request')
  }

  // Get Facebook client ID and secret from environment variables
  const fbClientId = process.env.FACEBOOK_CLIENT_ID
  const fbClientSecret = process.env.FACEBOOK_CLIENT_SECRET
  
  // Return error if Facebook client ID or secret is not found
  if(fbClientId === undefined || fbClientSecret === undefined ) {
    console.log('Missing Facebook environment values')
    throw new https.HttpsError('failed-precondition', 'Missing Facebook environment values')
  }

  // Convert code to a short lived access token
  const shortLivedToken = await getShortLivedToken(code, redirectURI, fbClientId, fbClientSecret)
  
  // Convert short lived access token to long lived token
  const longLivedToken = await getLongLivedToken(shortLivedToken, fbClientId, fbClientSecret)
  
  // Save Instagram never expire token to Firestore
  const userRef = admin.firestore().collection("users").doc(uid)
  
  return userRef.update({
    access_token_ig: longLivedToken,
    updatedAt: FieldValue.serverTimestamp()
  })
})

const getShortLivedToken = async (code: string, redirectURI: string, clientID: string, clientSecret: string) => {
  try {
    const { data } = await axios({
      url: 'https://graph.facebook.com/v16.0/oauth/access_token',
      method: 'get',
      params: {
        client_id: clientID,
        redirect_uri: redirectURI,
        client_secret: clientSecret,
        code: code
      }
    })

    return data.access_token
  } catch (error: any) {
    const errorMessage = error.response.data.error.message
    console.log(errorMessage)
    throw new https.HttpsError('unknown', `Failed to get short lived access token from Instagram: ${errorMessage}`)
  }
}

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
  const canvaRedirectURL = 'https://www.canva.com/apps/configured?'
  
  try {
    // Check if user is authenticated
    if (!context.auth) {
      throw new Error('User not authenticated')
    }
  
    // Get user ID from context
    const uid = context.auth.uid

    // Ensure that Canva user ID, brand ID and state is defined
    if (canvaUserId === undefined || canvaBrandId === undefined || canvaState === undefined) {
      throw new Error('Missing Canva user ID, brand ID or state')
    }
    
    // Check if the requesting Canva User ID is linked to an existing SwayTribe account
    const userDoc = admin.firestore().collection("users").doc(uid)
    const snapshot = await userDoc.get()
    const mergeOptions: SetOptions = { merge: true} 

    if(!snapshot.exists) {
      console.log(`There are no SwayTribe user that match this user ID ${uid}`)
      throw new Error('User not found in SwayTribe')
    }
    const data = snapshot.data()

    // Check if the user has any data stored in SwayTribe. Ideally they should
    if(data === undefined) {
      console.log(`There are no SwayTribe user that match this user ID ${uid}`)
      throw new Error('User not found in SwayTribe')
    }

    // Check if the SwayTribe user has linked any other Canva brands to SwayTribe
    // If yes, add the new brand ID to the existing array
    // If no, create a new array with the brand ID
    if (data.canvaBrandIds === undefined) {
      await userDoc.set({
        canvaUserId: canvaUserId,
        canvaBrandIds: [canvaBrandId],
        updatedAt: FieldValue.serverTimestamp()
      }, mergeOptions)
    } else {
      await userDoc.set({
        canvaUserId: canvaUserId,
        canvaBrandIds: FieldValue.arrayUnion(canvaBrandId),
        updatedAt: FieldValue.serverTimestamp()
      }, mergeOptions)
    }
    // Return a Canva redirect URL with a success query data
    const urlParams = new URLSearchParams({success: 'true', state: canvaState})
    return {success: true, canvaRedirectURL: canvaRedirectURL + urlParams.toString()}
  } catch (error) {
    // Return a Canva redirect URL with an error query data
    const urlParams = new URLSearchParams({success: 'false', state: canvaState})

    if (error instanceof Error) {
      console.log(error.message)
      urlParams.append('errors', error.message)
      return {success: false, canvaRedirectURL: canvaRedirectURL + urlParams.toString()}
    }

    console.log(`Error linking Canva user to SwayTribe account`, error)
    urlParams.append('errors', 'Unable to link Canva user to SwayTribe account')
    return {success: false, canvaRedirectURL: canvaRedirectURL + urlParams.toString()}
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
          res.status(401).send({isAuthenticated: false, errorMessage: error.message})
        } else {
          console.log(error)
          res.status(401).send({isAuthenticated: false, errorMessage: error})
        }
        return
      }
    })
  })
})

export const unlinkUserFromCanva = https.onRequest(async (req, res) => {
  if (req.url.includes('/configuration/delete')) {
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
  
          // Get the user data from database
          const doc = snapshot.docs[0]
          const userData = doc.data()
          const canvaBrandIds = userData.canvaBrandIds as [string]
  
          // Check number of Canva accounts (brand ID) linked to this SwayTribe account
          if (canvaBrandIds.length === 1) {
            // If the user only connected one Canva account (brand ID), remove the brand ID and canva user ID
            await doc.ref.update({
              canvaUserId: '',
              canvaBrandIds: FieldValue.arrayRemove(user.brandId),
              updatedAt: FieldValue.serverTimestamp()
            })
          } else {
            // If the user connected multiple Canva accounts (brand ID), remove only the brand ID that is being unlinked
            await doc.ref.update({
              canvaBrandIds: FieldValue.arrayRemove(user.brandId),
              updatedAt: FieldValue.serverTimestamp()
            })
          }
    
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
  } else if (req.url.includes('/configuration/start')) {
    cookieParserMiddleware(req, res, async () => {
      // The expiry time for the nonce cookie
      const COOKIE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
  
      // Generate a nonce
      const nonce = crypto.randomUUID();
  
      // Create an expiry time for the nonce
      const nonceExpiry = Date.now() + COOKIE_EXPIRY_MS;
  
      // Store the nonce and expiry time in a JSON string
      const nonceWithExpiry = JSON.stringify([nonce, nonceExpiry]);
  
      // Store the nonce and expiry time in a cookie
      res.cookie("nonceWithExpiry", nonceWithExpiry, {
        httpOnly: true,
        secure: true,
        signed: true,
        maxAge: COOKIE_EXPIRY_MS,
      })

      // Get the state from the query string
      const { state } = req.query

      // Set the redirect URL params
      const urlParams = new URLSearchParams({
        state: state as string,
        nonce: nonce as string
      })

      // Redirect to the Canva auth page
      res.redirect(`https://www.canva.com/apps/configure/link?${urlParams.toString()}`)
      return
    })
  } else {
    console.log(`This is not a valid URL for this trigger`)
    res.status(200).send({type: "FAIL", message: "This is not a valid URL for this trigger"})
    return
  }
})

export const redirectCanvaToSwayTribe = https.onRequest(async (req, res) => {
  corsHandler(req, res, async () => {
    cookieParserMiddleware(req, res, async () => {
      // Check if the nonce in the query string matches the nonce in the cookie
      try {
        // Get the nonce from the query string and the nonce expiry datetime from the cookie
        const nonceQuery = req.query.nonce as string
        const nonceWithExpiryCookie = req.signedCookies.nonceWithExpiry as string

        const nonceWithExpiry = JSON.parse(nonceWithExpiryCookie)
        const [nonceCookie, nonceExpiry] = nonceWithExpiry
        // Clear the nonce cookie
        res.clearCookie('nonceWithExpiry')
    
        // Check if the nonce is valid
        if (
          Date.now() > nonceExpiry ||
          typeof nonceCookie !== 'string' ||
          typeof nonceQuery !== 'string' ||
          nonceCookie.length < 1 ||
          nonceQuery.length < 1 ||
          nonceCookie !== nonceQuery
        ) {
          throw Error('Invalid nonce')
        }
      } catch (error) {
        // Return error if nonce validation has failed
        if (error instanceof Error) {
          console.log(error.message)
        } else {
          console.log(error)
        }
        const urlParams = new URLSearchParams({success: "false", state: req.query.state as string, errors: "invalid_nonce",})

        res.status(302).redirect('https://www.canva.com/apps/configured?' + urlParams.toString())
        return
      }

      // Creating a new request object with the Canva user data
      const extendedReq = Object.create(req) as ExtendedFirebaseRequest
      const redirectJwtMiddleware = createJwtMiddleware(getTokenFromQueryString)
      redirectJwtMiddleware(extendedReq, res, async () => {
        const canvaUserId = extendedReq.canva.userId as string
        const canvaBrandId = extendedReq.canva.brandId as string
        const canvaState = extendedReq.query.state as string
  
        if(canvaUserId === undefined || canvaBrandId === undefined || canvaState === undefined) {
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
        if (error instanceof AxiosError) {
          console.log(`Error getting business account details:`, error.response!.data.error.message);
          res.status(401).send({type: 'FAIL', errorMessage: error.response!.data.error.error_user_msg})
          return
        }

        if (error instanceof Error) {
          res.status(401).send({type: 'FAIL', errorMessage: error.message})
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
          throw new Error('No SwayTribe account exist for this Canva user')
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
      } catch(error: any) {
        if (error instanceof AxiosError) {
          console.log(`Error getting business account details:`, error.response!.data.error.message);
          res.status(401).send({type: 'FAIL', errorMessage: error.response!.data.error.error_user_msg})
          return
        }

        if (error instanceof Error) {
          res.status(401).send({type: 'FAIL', errorMessage: error.message})
          return
        }
      }
    })
  })
})

export const getMediaFromIGUser = runWith({memory: '1GB'}).https.onRequest(async (req, res) => {
  corsHandler(req, res, async () => {
    // Creating a new request object with the Canva user data
    const extendedReq = Object.create(req) as ExtendedFirebaseRequest
    jwtMiddleware(extendedReq, res, async () => {
      try {
        // Get Canva user from request
        const user = extendedReq.canva
        const canvaUserId = user.userId
        const canvaBrandId = user.brandId
        const businessProfileName = req.query.profileName as string
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

        // Filter out any media that doesn't have a media_url. This is likely due to copyright issues
        // Refer here https://developers.facebook.com/docs/instagram-api/reference/ig-media#:~:text=or%20VIDEO.-,media_url,-Public
        const medias = business_media.data
        const filteredMedias = medias.filter((media: any) => media.media_url !== undefined)

        // Loop through the business media (video only)
        // Create a thumbnail for each video and save it to cloud storage
        // Get the download URL for the created thumbnail
        // Add the thumbnail URL to the Instagram media object
        const thumbnailPromises = filteredMedias.map(async (media: any) => {
          if (media.media_type === 'VIDEO') {
            const videoURL = media.media_url
            const thumbnailFileName = businessProfileName + '-' + media.id.toString()
            const videoData = await createOrGetVideoData(videoURL, thumbnailFileName)
            media.thumbnail_url = videoData.thumbnailDownloadURL
            media.durationInSeconds = videoData.durationInSeconds
          }
          return media
        });
        const finalMedias = await Promise.all(thumbnailPromises)

        // Return all the Instagram media for this business account
        res.status(200).send({type: 'SUCCESS', data: finalMedias})
        return
      } catch (error) {
        if (error instanceof AxiosError) {
          console.log(`Error getting Instagram media from requested page:`, error.response!.data.error.message);
          res.status(401).send({type: 'FAIL', message: error.response!.data.error.error_user_msg})
          return
        }

        if (error instanceof Error) {
          res.status(401).send({type: 'FAIL', message: error.message})
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