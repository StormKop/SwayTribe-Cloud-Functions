import { https } from "firebase-functions/v1";
import { IncomingHttpHeaders } from "http";
import { createHmac } from "crypto";
import QueryString from "qs";

/**
 * Checks if a POST request is valid.
 */
export function isValidPostRequest(secret: string, request: https.Request) {
  const sentAtSeconds = Number(request.header("X-Canva-Timestamp"));
  const receivedAtSeconds = new Date().getTime() / 1000;

  if (!isValidTimestamp(sentAtSeconds, receivedAtSeconds)) {
    return false;
  }

  const version = "v1";
  const headers = createHeaderString(request.headers);
  const endpoint = request.path;
  const body = request["rawBody"];
  const payload = `${version}:${headers}:${endpoint}:${body}`;

  const signature = calculateSignature({ payload, secret });

  if (!String(request.header("X-Canva-Signatures")).includes(signature)) {
    return false;
  }

  return true;
}

/**
 * Checks if a GET request is valid.
 */
export function isValidGetRequest(secret: string, request: https.Request) {
  const sentAtSeconds = Number(request.header("X-Canva-Timestamp"));
  const receivedAtSeconds = new Date().getTime() / 1000;

  if (!isValidTimestamp(sentAtSeconds, receivedAtSeconds)) {
    return false;
  }

  const version = "v1";
  const headers = createHeaderString(request.headers);
  const endpoint = request.path;
  const params = createQueryParameterString(request.query);
  const payload = `${version}:${headers}:${endpoint}:${params}`;

  const signature = calculateSignature({ secret, payload });

  if (!String(request.header("X-Canva-Signatures")).includes(signature)) {
    return false;
  }

  return true;
}

/**
 * Checks if a Redirect URL is valid.
 */
export function isValidRedirectUrl(secret: string, request: https.Request) {
  const sentAtSeconds = Number(request.query.time);
  const receivedAtSeconds = new Date().getTime() / 1000;

  if (!isValidTimestamp(sentAtSeconds, receivedAtSeconds)) {
    return false;
  }

  const version = "v1";
  const { time, user, brand, extensions, state, signatures } = request.query;
  const payload = `${version}:${time}:${user}:${brand}:${extensions}:${state}`;

  const signature = calculateSignature({ secret, payload });

  if (!String(signatures).includes(signature)) {
    return false;
  }

  return true;
}

/**
 * Checks if `sentAt` is within 300 seconds of `receivedAt`.
 */
function isValidTimestamp(
  sentAt: string | number,
  receivedAt: string | number = Date.now() / 1000
) {
  const MAX_TIME_DIFFERENCE_SECONDS = 300; // 5 minutes
  const difference = Number(sentAt) - Number(receivedAt);
  return Math.abs(difference) < MAX_TIME_DIFFERENCE_SECONDS;
}

/**
 * Creates a colon-separated string of header values, sorting them by their
 * name in alphabetical order and filtering out certain headers.
 */
function createHeaderString(headers: IncomingHttpHeaders) {
  const FILTERED_HEADERS = ["x-canva-signature", "x-forwarded-"];

  return Object.keys(headers)
    .filter((header) => header.startsWith("x-"))
    .filter(
      (header) =>
        !FILTERED_HEADERS.some((filteredHeader) =>
          header.startsWith(filteredHeader)
        )
    )
    .sort()
    .map((key) => headers[key])
    .join(":");
}

/**
 * Creates a colon-separated string of query parameter values, sorting them
 * by their name in alphabetical order.
 */
function createQueryParameterString(params: QueryString.ParsedQs) {
  return Object.keys(params)
    .filter((param) => param.startsWith("x-"))
    .sort()
    .map((key) => params[key])
    .join(":");
}

/**
 * Calculates a request signature.
 */
function calculateSignature({
  payload,
  secret,
}: {
  payload: string;
  secret: string;
}) {
  const key = Buffer.from(secret, "base64");
  return createHmac("sha256", key).update(payload).digest("hex");
}