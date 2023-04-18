import { https } from "firebase-functions/v1";
import jwt, { JwtPayload } from 'jsonwebtoken';
import { JwksClient } from "jwks-rsa";

interface CanvaUser {
  userId: string,
  brandId: string
}

const CACHE_EXPIRY_MS = 60 * 60 * 1_000; // 60 minutes
const TIMEOUT_MS = 30 * 1_000; // 30 seconds

// Verify JWT token and return Canva user
export const getCanvaUser = async (request: https.Request, appId: string): Promise<CanvaUser> => {
  const token = getTokenFromHeader(request)
  const decodedToken = jwt.decode(token, { complete: true })

  // Get kid
  const kid =  decodedToken?.header.kid
  if (!kid) {
    throw new Error('kid is missing')
  }

  // Get the public key
  const jwks = new JwksClient({
    cache: true,
    cacheMaxAge: CACHE_EXPIRY_MS,
    timeout: TIMEOUT_MS,
    rateLimit: true,
    jwksUri: `https://api.canva.com/rest/v1/apps/${appId}/jwks`,
  });
  const signingKey = await jwks.getSigningKey(kid);
  const publicKey = signingKey.getPublicKey();

  // Verify and validate the JWT
  const verified = jwt.verify(token, publicKey, { audience: appId }) as JwtPayload;
  const isValidToken = verified.aud || verified.brandId || verified.userId

  // Return Canva user if token is valid else return an error
  if (isValidToken) {
    return {
      userId: verified.userId,
      brandId: verified.brandId
    }
  } else {
    throw new Error("Invalid token")
  }
}

// Get token from Authorization header
function getTokenFromHeader(request: https.Request) {
  const header = request.header("Authorization")

  if (!header) {
    throw new Error("Authorization header is missing");
  }

  const parts = header.split(" ");

  if (parts.length !== 2 || parts[0] !== "Bearer") {
    throw new Error("Invalid Authorization header format");
  }

  const [_, token] = parts;

  return token;
}

// interface AuthKeyJson {
//   auth_key: AuthKey;
// }

// interface AuthKey {
//   app: string;
//   public_keys: PublicKey[];
// }

// interface PublicKey {
//   key_id: string;
//   activation_time_ms: number;
//   jwk: string;
// }

// // Find public key from the returned JSON
// function findPublicKeyById(json: AuthKeyJson, kid: string): PublicKey | undefined {
//   return json.auth_key.public_keys.find((key) => key.key_id === kid);
// }

// // Get Auth key JSON from database
// export const getPublicKeyJson = async (): Promise<AuthKeyJson> => {
//     // Search database for public key
//     const publicKeyRef = admin.firestore().collection("canva").doc("publicKey")
//     const snapshot = await publicKeyRef.get()
//     const data = snapshot.data()
//     if (data === undefined) {
//       throw new Error("Failed to find Canva public key in database")
//     }
//     const authKeyJson = data.publicKeys as AuthKeyJson
//     return authKeyJson
// }