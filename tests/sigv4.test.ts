import { describe, it, expect } from 'vitest';
import { signRequest } from '../src/main/utils/sigv4';

describe('signRequest (AWS SigV4)', () => {
  // Official AWS sig-v4-test-suite `get-vanilla` vector.
  // creds/date/region/service are the suite's fixed values.
  it('matches the AWS get-vanilla test vector', () => {
    const headers = signRequest({
      method: 'GET',
      host: 'example.amazonaws.com',
      path: '/',
      region: 'us-east-1',
      service: 'service',
      body: '',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      amzDate: '20150830T123600Z',
    });

    expect(headers['Authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
      'SignedHeaders=host;x-amz-date, ' +
      'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    expect(headers['X-Amz-Date']).toBe('20150830T123600Z');
  });

  it('includes signed extra headers in SignedHeaders, sorted', () => {
    const headers = signRequest({
      method: 'POST',
      host: 'bedrock-runtime.us-east-1.amazonaws.com',
      path: '/model/anthropic.claude-3-5-haiku-20241022-v1:0/invoke',
      region: 'us-east-1',
      service: 'bedrock',
      body: '{}',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      extraHeaders: { 'Content-Type': 'application/json' },
      amzDate: '20150830T123600Z',
    });
    expect(headers['Authorization']).toContain('SignedHeaders=content-type;host;x-amz-date');
    expect(headers['Content-Type']).toBe('application/json');
  });
});
