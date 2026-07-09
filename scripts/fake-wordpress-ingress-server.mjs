#!/usr/bin/env node
/**
 * A minimal fake of the WordPress side of the email-ingress contract, for
 * local development and demos without a running WordPress site.
 *
 * Serves:
 *   HEAD /            → Link: </wp-json/>; rel="https://api.w.org/"
 *   GET  /wp-json/    → REST index advertising one email_ingress_endpoint
 *   POST /wp-json/bh-wp-mailboxes/v1/incoming-email
 *                     → logs envelope headers, saves the raw body to
 *                       received-emails/<n>.eml, responds 201
 *
 * Usage:
 *   node scripts/fake-wordpress-ingress-server.mjs [port]
 *
 * Then point the worker at it (cloudflare-worker/.dev.vars):
 *   TARGET_WORDPRESS_SITE_URL=http://localhost:8899
 */

import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] ?? 8899);
const baseUrl = `http://localhost:${String(port)}`;
const ingressPath = '/wp-json/bh-wp-mailboxes/v1/incoming-email';
const receivedEmailsDirectory = join(import.meta.dirname, '..', 'received-emails');

let receivedEmailCount = 0;

const server = createServer((request, response) => {
  if (request.method === 'HEAD') {
    response.writeHead(200, { link: `<${baseUrl}/wp-json/>; rel="https://api.w.org/"` });
    response.end();
    return;
  }

  if (request.method === 'GET' && request.url === '/wp-json/') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        name: 'Fake WordPress ingress server',
        namespaces: ['wp/v2', 'bh-wp-mailboxes/v1'],
        email_ingress_endpoints: [
          {
            version: 1,
            namespace: 'bh-wp-mailboxes/v1',
            url: `${baseUrl}${ingressPath}`,
            accepts: 'message/rfc822',
            max_message_size_bytes: 26214400,
          },
        ],
      }),
    );
    return;
  }

  if (request.method === 'POST' && request.url === ingressPath) {
    const bodyChunks = [];
    request.on('data', (chunk) => bodyChunks.push(chunk));
    request.on('end', () => {
      receivedEmailCount += 1;
      const rawEmailBody = Buffer.concat(bodyChunks);

      mkdirSync(receivedEmailsDirectory, { recursive: true });
      const savedFilePath = join(receivedEmailsDirectory, `${String(receivedEmailCount)}.eml`);
      writeFileSync(savedFilePath, rawEmailBody);

      console.log(`--- Incoming email #${String(receivedEmailCount)} ---`);
      console.log(
        `  Authorization:     ${request.headers.authorization ? 'Basic ***present***' : 'MISSING'}`,
      );
      console.log(`  Content-Type:      ${request.headers['content-type'] ?? ''}`);
      console.log(`  X-Envelope-From:   ${request.headers['x-envelope-from'] ?? ''}`);
      console.log(`  X-Envelope-To:     ${request.headers['x-envelope-to'] ?? ''}`);
      console.log(`  X-Message-Raw-Size:${request.headers['x-message-raw-size'] ?? ''}`);
      console.log(
        `  Body:              ${String(rawEmailBody.byteLength)} bytes → ${savedFilePath}`,
      );

      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ stored: true, id: receivedEmailCount }));
    });
    return;
  }

  response.writeHead(404);
  response.end('Not found.');
});

server.listen(port, () => {
  console.log(`Fake WordPress ingress server listening on ${baseUrl}`);
  console.log(`Advertising ${baseUrl}${ingressPath} in the REST index.`);
});
