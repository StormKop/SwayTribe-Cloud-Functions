import { Response as FirebaseResponse, Request as FirebaseRequest } from "firebase-functions/v1";
import jwt from 'jsonwebtoken';
import { JwksClient, SigningKeyNotFoundError } from "jwks-rsa";

/**
 * This file contains the JWT verification code for Canva's serverless platform.
 * It is based on the code provided in the Canva starter kit
 */

// Interface that extends the Firebase Request to include the Canva specific fields
export interface ExtendedFirebaseRequest extends FirebaseRequest {
  canva: {
    appId?: string;
    brandId?: string;
    userId?: string;
  };
}

type CanvaJwt = Omit<jwt.Jwt, "payload"> & {
  payload: {
    aud?: string;
    userId?: string;
    brandId?: string;
  };
};

// Constants for JWT verification
const CACHE_EXPIRY_MS = 60 * 60 * 1_000; // 60 minutes
const TIMEOUT_MS = 30 * 1_000; // 30 seconds

// Helper functions
const createJwksUrl = (appId: string) => `https://api.canva.com/rest/v1/apps/${appId}/jwks`;
const sendUnauthorizedResponse = (res: FirebaseResponse, message?: string) => res.status(401).json({ error: "unauthorized", message });

export function createJwtMiddleware(getTokenFromRequest: (req: FirebaseRequest) => Promise<string> | string = getTokenFromHttpHeader) {
  // TODO: Set the CANVA_APP_ID environment variable in the project's .env file
  const appId = process.env.CANVA_APP_ID

  if (!appId) {
    throw new Error(
      `The CANVA_APP_ID environment variable is undefined. Set the variable in the project's .env file.`
    );
  }

  return constructJwtMiddleware({appId, getTokenFromRequest});
}

// Middleware function that verifies the JWT - This code is taken from the Canva documentation
const constructJwtMiddleware = (
  {appId, getTokenFromRequest} : {appId: string; getTokenFromRequest: (req: FirebaseRequest) => Promise<string> | string}
  ): ((req: ExtendedFirebaseRequest, res: FirebaseResponse, next: (error?: any) => void) => void) => {
  const jwksClient = new JwksClient({
    cache: true,
    cacheMaxAge: CACHE_EXPIRY_MS,
    timeout: TIMEOUT_MS,
    rateLimit: true,
    jwksUri: createJwksUrl(appId),
  });

  return async(req, res, next) => {
    try {
      const token = await getTokenFromRequest(req);
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
      if (e instanceof JWTAuthorizationError) {
        return sendUnauthorizedResponse(res, e.message);
      }

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

// Get the JWT from the request query -- this is only used for the redirect URL function
export const getTokenFromQueryString = (req: FirebaseRequest): string => {
  // The name of a query string parameter bearing the JWT
  const tokenQueryStringParamName = "canva_user_token";

  const queryParam = req.query[tokenQueryStringParamName];
  if (!queryParam || typeof queryParam !== "string") {
    console.trace(
      `jwtMiddleware: missing "${tokenQueryStringParamName}" query parameter`
    );
    throw new JWTAuthorizationError(
      `Missing "${tokenQueryStringParamName}" query parameter`
    );
  }

  if (!looksLikeJWT(queryParam)) {
    console.trace(
      `jwtMiddleware: invalid "${tokenQueryStringParamName}" query parameter`
    );
    throw new JWTAuthorizationError(
      `Invalid "${tokenQueryStringParamName}" query parameter`
    );
  }

  return queryParam;
};

// Get the JWT from the request header -- this is likely the default method for most functions
const getTokenFromHttpHeader = (req: FirebaseRequest): string => {
  // The names of a HTTP header bearing the JWT, and a scheme
  const headerName = "Authorization";
  const schemeName = "Bearer";

  const header = req.headers.authorization;
  if (!header) {
    throw new JWTAuthorizationError(`Missing the "${headerName}" header`);
  }

  if (!header.match(new RegExp(`^${schemeName}\\s+[^\\s]+$`, "i"))) {
    console.trace(
      `jwtMiddleware: failed to match token in "${headerName}" header`
    );
    throw new JWTAuthorizationError(
      `Missing a "${schemeName}" token in the "${headerName}" header`
    );
  }

  const token = header.replace(new RegExp(`^${schemeName}\\s+`, "i"), "");
  if (!token || !looksLikeJWT(token)) {
    throw new JWTAuthorizationError(
      `Invalid "${schemeName}" token in the "${headerName}" header`
    );
  }

  return token;
};

/**
 * A class representing JWT validation errors in the JWT middleware.
 * The error message provided to the constructor will be forwarded to the
 * API consumer trying to access a JWT-protected endpoint.
 * @private
 */
class JWTAuthorizationError extends Error {
  constructor(message: string) {
    super(message);

    Object.setPrototypeOf(this, JWTAuthorizationError.prototype);
  }
}

const looksLikeJWT = (token: string): boolean => token.match(/^[a-z0-9+/\-_=.]+$/i) != null;
  // Base64 alphabet includes
  //   - letters (a-z and A-Z)
  //   - digits (0-9)
  //   - two special characters (+/ or -_)
  //   - padding (=)