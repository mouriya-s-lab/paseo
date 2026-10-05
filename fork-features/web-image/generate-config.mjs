#!/usr/bin/env node
// Startup generator for the fork's split-deployment web image
// (fork-features/web-image/Dockerfile). The deployment declares the daemon
// inventory and mounts it read-only at DAEMONS_FILE; this script validates it
// and derives the nginx proxy routes plus the same-origin manifest that
// packages/app/src/fork-features/self-hosted/runtime.ts parses. Nothing is
// written unless the whole inventory is valid.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";

const DAEMONS_FILE = "/etc/paseo/daemons.json";
const NGINX_FILE = "/etc/nginx/conf.d/default.conf";
const MANIFEST_FILE = "/usr/share/nginx/html/_paseo/hosts.json";
const DAEMON_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DNS_HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/iu;

/**
 * @typedef {object} DaemonDefinition
 * @property {string} id
 * @property {string} label
 * @property {string} upstream
 */

/**
 * @typedef {object} ValidatedDaemon
 * @property {string} id
 * @property {string} label
 * @property {string} upstream
 * @property {string} authority
 * @property {string} origin
 */

/**
 * @typedef {object} HostManifestEntry
 * @property {string} id
 * @property {string} label
 * @property {string} basePath
 */

/**
 * @param {string} message
 * @returns {never}
 */
function invalid(message) {
  throw new Error(`Invalid ${DAEMONS_FILE}: ${message}`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {number} index
 * @returns {string}
 */
function validateId(value, index) {
  if (typeof value !== "string" || value.length === 0 || !DAEMON_ID.test(value)) {
    invalid(`daemons[${index}].id must be a non-empty lowercase slug`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {number} index
 * @returns {string}
 */
function validateLabel(value, index) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    invalid(`daemons[${index}].label must be a non-empty string without control characters`);
  }
  return value;
}

/**
 * Parse one trusted HTTP origin. The raw authority check deliberately happens
 * before URL parsing so URL's path normalization cannot turn a path into '/'.
 *
 * @param {unknown} value
 * @param {number} index
 * @returns {{ authority: string, origin: string, upstream: string }}
 */
function validateUpstream(value, index) {
  const parsed = parseUpstreamUrl(value, index);

  if (
    parsed.protocol !== "http:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.hostname === ""
  ) {
    invalid(`daemons[${index}].upstream must be an HTTP origin without credentials or a path`);
  }
  const hostname =
    parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
  if (isIP(hostname) === 0 && !DNS_HOSTNAME.test(hostname)) {
    invalid(`daemons[${index}].upstream hostname must be a DNS name or IP literal`);
  }

  // URL.host is normalized (including IPv6 brackets and the effective port),
  // so it is safe to reuse for both proxy routing and Host/Origin headers.
  return {
    authority: parsed.host,
    origin: `http://${parsed.host}`,
    upstream: `http://${parsed.host}`,
  };
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * @param {unknown} value
 * @param {number} index
 * @returns {URL}
 */
function parseUpstreamUrl(value, index) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    invalid(`daemons[${index}].upstream must be an HTTP origin`);
  }
  if (hasControlCharacter(value) || !value.startsWith("http://")) {
    invalid(`daemons[${index}].upstream must be an HTTP origin`);
  }

  const rawAuthority = value.slice("http://".length);
  const authority = rawAuthority.endsWith("/") ? rawAuthority.slice(0, -1) : rawAuthority;
  if (
    authority.length === 0 ||
    authority.includes("/") ||
    authority.includes("\\") ||
    authority.includes("?") ||
    authority.includes("#") ||
    /\s/u.test(authority)
  ) {
    invalid(`daemons[${index}].upstream must not contain a path, query, fragment, or whitespace`);
  }

  try {
    return new URL(value);
  } catch {
    invalid(`daemons[${index}].upstream must be a valid HTTP origin`);
  }
}

/**
 * @param {unknown} value
 * @returns {ValidatedDaemon[]}
 */
function validateDaemons(value) {
  if (!Array.isArray(value)) {
    invalid("top level value must be an array");
  }

  /** @type {ValidatedDaemon[]} */
  const daemons = [];
  const ids = new Set();

  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      invalid(`daemons[${index}] must be an object`);
    }

    const keys = Object.keys(entry).sort();
    if (keys.length !== 3 || keys[0] !== "id" || keys[1] !== "label" || keys[2] !== "upstream") {
      invalid(`daemons[${index}] must contain only id, label, and upstream`);
    }

    const id = validateId(entry.id, index);
    if (ids.has(id)) {
      invalid(`duplicate id ${id}`);
    }
    ids.add(id);

    const label = validateLabel(entry.label, index);
    const parsedUpstream = validateUpstream(entry.upstream, index);
    daemons.push({
      id,
      label,
      upstream: parsedUpstream.upstream,
      authority: parsedUpstream.authority,
      origin: parsedUpstream.origin,
    });
  });

  return daemons;
}

/**
 * @param {string} value
 * @returns {string}
 */
function nginxString(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$")}"`;
}

/**
 * @param {ValidatedDaemon} daemon
 * @returns {string}
 */
function proxyLocations(daemon) {
  const prefix = `/daemons/${daemon.id}`;
  const upstream = nginxString(daemon.upstream);
  const authority = nginxString(daemon.authority);
  const origin = nginxString(daemon.origin);
  const common = [
    "        proxy_http_version 1.1;",
    "        proxy_set_header Upgrade $http_upgrade;",
    "        proxy_set_header Connection $connection_upgrade;",
    `        proxy_set_header Host ${authority};`,
    `        proxy_set_header Origin ${origin};`,
    "        proxy_set_header X-Real-IP $remote_addr;",
    "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "        proxy_set_header X-Forwarded-Proto $scheme;",
    "        proxy_buffering off;",
    "        proxy_request_buffering off;",
    "        proxy_read_timeout 86400s;",
    "        proxy_send_timeout 86400s;",
    "        proxy_redirect off;",
  ].join("\n");

  return [
    `    location = ${prefix} {`,
    `        set $paseo_daemon_upstream ${upstream};`,
    "        rewrite ^ / break;",
    "        proxy_pass $paseo_daemon_upstream;",
    common,
    "    }",
    "",
    `    location ^~ ${prefix}/ {`,
    `        set $paseo_daemon_upstream ${upstream};`,
    `        rewrite ^${prefix}/(.*)$ /$1 break;`,
    "        proxy_pass $paseo_daemon_upstream;",
    common,
    "    }",
  ].join("\n");
}

/**
 * @param {ValidatedDaemon[]} daemons
 * @returns {string}
 */
function renderNginx(daemons) {
  const locations = daemons.map(proxyLocations).join("\n\n");
  return `map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

# Docker's embedded resolver keeps an offline daemon from blocking nginx startup.
resolver 127.0.0.11 valid=10s ipv6=off;

server {
    listen 6767;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # Explicit daemon routes must win over the SPA fallback. The generated
    # locations strip /daemons/<id> before forwarding every HTTP/WS path.
${locations ? `${locations}\n\n` : ""}    location = /daemons {
        return 404;
    }

    location ^~ /daemons/ {
        return 404;
    }

    location = /_paseo/hosts.json {
        default_type application/json;
        add_header Cache-Control "no-store" always;
        try_files $uri =404;
    }

    location = /_paseo {
        return 404;
    }

    location ^~ /_paseo/ {
        return 404;
    }

    location = /index.html {
        add_header Cache-Control "no-store" always;
        try_files $uri =404;
    }

    # Hashed/static assets may be cached, while index.html remains revalidated.
    location ~* \\.(?:css|js|mjs|map|png|jpg|jpeg|gif|svg|ico|webp|avif|woff2?)$ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
`;
}

/**
 * @param {ValidatedDaemon[]} daemons
 * @returns {string}
 */
function renderManifest(daemons) {
  /** @type {HostManifestEntry[]} */
  const manifest = daemons.map(({ id, label }) => ({
    id,
    label,
    basePath: `/daemons/${id}`,
  }));
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * @param {string} filePath
 * @param {string} content
 * @returns {void}
 */
function writeAtomically(filePath, content) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o644 });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Preserve the original write/rename error.
    }
    throw error;
  }
}

/** @returns {void} */
function main() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(DAEMONS_FILE, "utf8"));
  } catch (error) {
    const reason = error instanceof SyntaxError ? "must contain valid JSON" : "could not be read";
    throw new Error(`${DAEMONS_FILE} ${reason}`, { cause: error });
  }

  // No output is touched until the complete input has passed validation.
  const daemons = validateDaemons(parsed);
  const nginx = renderNginx(daemons);
  const manifest = renderManifest(daemons);

  mkdirSync(dirname(MANIFEST_FILE), { recursive: true });
  writeAtomically(NGINX_FILE, nginx);
  writeAtomically(MANIFEST_FILE, manifest);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`Paseo startup configuration failed: ${message}`);
  process.exitCode = 1;
}
