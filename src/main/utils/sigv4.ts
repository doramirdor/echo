import { createHash, createHmac } from 'crypto';

/**
 * Minimal AWS Signature Version 4 signer (no SDK dependency).
 *
 * Covers the case Echo needs: a single signed POST/GET to a regional AWS
 * endpoint with static credentials. The path is treated as already canonical
 * (used verbatim for both the canonical request and the wire request), which
 * matches the AWS sig-v4 test-suite `get-vanilla` vector and how Bedrock model
 * paths (e.g. `/model/anthropic.claude-...:0/invoke`) are sent.
 *
 * Verified against the official AWS test vector in tests/sigv4.test.ts.
 */
export interface SigV4Request {
  method: string;
  host: string;
  /** Absolute path, used verbatim as the canonical URI and the request path. */
  path: string;
  region: string;
  service: string;
  /** Request payload as a string ('' for empty bodies). */
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Extra headers to include in the signature AND send (e.g. content-type). */
  extraHeaders?: Record<string, string>;
  /** Override the timestamp (YYYYMMDDTHHMMSSZ). For testing/determinism. */
  amzDate?: string;
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function formatAmzDate(d: Date): string {
  // '2015-08-30T12:36:00.000Z' -> '20150830T123600Z'
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * Returns the headers to send with the request, including `Authorization`,
 * `X-Amz-Date`, and any `extraHeaders`. The caller sends these on the wire and
 * lets the HTTP client add the `Host` header (which is part of the signature).
 */
export function signRequest(req: SigV4Request): Record<string, string> {
  const amzDate = req.amzDate ?? formatAmzDate(new Date());
  const dateStamp = amzDate.slice(0, 8);

  // Headers that participate in the signature (names lowercased, sorted).
  const signHeaders: Record<string, string> = {
    host: req.host,
    'x-amz-date': amzDate,
  };
  for (const [k, v] of Object.entries(req.extraHeaders ?? {})) {
    signHeaders[k.toLowerCase()] = v;
  }
  if (req.sessionToken) signHeaders['x-amz-security-token'] = req.sessionToken;

  const sortedNames = Object.keys(signHeaders).sort();
  const canonicalHeaders = sortedNames.map(n => `${n}:${signHeaders[n].trim()}\n`).join('');
  const signedHeaders = sortedNames.join(';');
  const payloadHash = sha256Hex(req.body);

  const canonicalRequest = [
    req.method,
    req.path,
    '', // canonical query string (none)
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac('AWS4' + req.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, req.region);
  const kService = hmac(kRegion, req.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const out: Record<string, string> = {
    'X-Amz-Date': amzDate,
    'Authorization': `AWS4-HMAC-SHA256 Credential=${req.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    ...(req.extraHeaders ?? {}),
  };
  if (req.sessionToken) out['X-Amz-Security-Token'] = req.sessionToken;
  return out;
}
