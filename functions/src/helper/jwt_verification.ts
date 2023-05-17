import { Response as FirebaseResponse, Request as FirebaseRequest } from "firebase-functions/v1";
import jwt from 'jsonwebtoken';
import { JwksClient, SigningKeyNotFoundError } from "jwks-rsa";

// Interface that extends the FirebaseRequest interface to include the Canva specific fields
export interface ExtendedFirebaseRequest extends FirebaseRequest {
  canva: {
    appId?: string;
    brandId?: string;
    userId?: string;
  };
}

// Constants for JWT verification
const CACHE_EXPIRY_MS = 60 * 60 * 1_000; // 60 minutes
const TIMEOUT_MS = 30 * 1_000; // 30 seconds

// Helper functions
const createJwksUrl = (appId: string) => `https://api.canva.com/rest/v1/apps/${appId}/jwks`;
const sendUnauthorizedResponse = (res: FirebaseResponse, message?: string) => res.status(401).json({ error: "unauthorized", message });

type CanvaJwt = Omit<jwt.Jwt, "payload"> & {
  payload: {
    aud?: string;
    userId?: string;
    brandId?: string;
  };
};

export function createJwtMiddleware() {
  // TODO: Set the CANVA_APP_ID environment variable in the project's .env file
  const appId = process.env.CANVA_APP_ID

  if (!appId) {
    throw new Error(
      `The CANVA_APP_ID environment variable is undefined. Set the variable in the project's .env file.`
    );
  }

  return constructJwtMiddleware(appId);
}

// Middleware function that verifies the JWT - This code is taken from the Canva documentation
const constructJwtMiddleware = (appId: string): ((req: ExtendedFirebaseRequest, res: FirebaseResponse, next: (error?: any) => void) => void) => {
  const jwksClient = new JwksClient({
    cache: true,
    cacheMaxAge: CACHE_EXPIRY_MS,
    timeout: TIMEOUT_MS,
    rateLimit: true,
    jwksUri: createJwksUrl(appId),
  });

  return async(req, res, next) => {
    try {
      console.log(`Processing JWT for ${req.url}`)
      if(!req.headers.authorization) {
        return sendUnauthorizedResponse(res, "Authorization header is missing")
      }

      if (!req.headers.authorization.match(/^Bearer\s+[a-z0-9+\\=]/i)) {
        console.trace(
          `jwtMiddleware: failed to match token in Authorization header`
        );
        return sendUnauthorizedResponse(res, "Invalid token format");
      }

      const token = req.headers.authorization.replace(/^Bearer\s+/i, "");
      if (!token) {
        console.trace(
          `jwtMiddleware: failed to extract token from Authorization header`
        );
        return sendUnauthorizedResponse(res, "Invalid token format");
      }

      const unverifiedDecodedToken = jwt.decode(token, {
        complete: true,
      });

      if (unverifiedDecodedToken?.header?.kid == null) {
        console.trace(
          `jwtMiddleware: expected token to contain 'kid' claim header`
        );
        return sendUnauthorizedResponse(res);
      }

      const key = await jwksClient.getSigningKey(
        unverifiedDecodedToken.header.kid
      );
      const publicKey = key.getPublicKey();
      const verifiedToken = jwt.verify(token, publicKey, {
        audience: appId,
        complete: true,
      }) as CanvaJwt;

      const { payload } = verifiedToken;
      // console.log("payload: %O", payload);

      if (
        payload.userId == null ||
        payload.brandId == null ||
        payload.aud == null
      ) {
        console.trace(
          "jwtMiddleware: failed to decode jwt missing fields from payload"
        );
        return sendUnauthorizedResponse(res);
      }

      req.canva = {
        appId: payload.aud,
        brandId: payload.brandId,
        userId: payload.userId,
      };

      next();
    } catch (e) {
      if (e instanceof SigningKeyNotFoundError) {
        return sendUnauthorizedResponse(res, "Public key not found");
      }

      if (e instanceof jwt.JsonWebTokenError) {
        return sendUnauthorizedResponse(res, "Token is invalid");
      }

      if (e instanceof jwt.TokenExpiredError) {
        return sendUnauthorizedResponse(res, "Token expired");
      }

      return next(e);
    }
  }
}