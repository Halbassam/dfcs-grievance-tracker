"use strict";

/**
 * Thin wrapper around Supabase's Storage REST API, using Node 18's
 * built-in fetch -- deliberately no supabase-js or any other new npm
 * dependency, matching how the rest of this app is built.
 *
 * Requires two environment variables (set these in Render):
 *   SUPABASE_URL               e.g. https://xxxxxxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  Project Settings -> API -> service_role key
 *
 * The service-role key bypasses RLS/bucket privacy by design -- that's
 * expected and fine here, because this module only ever runs on the
 * server. It must never be sent to the browser or used client-side.
 */

const BUCKET = "grievance-attachments";

function requireConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "File attachments aren't configured yet -- SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment."
    );
  }
  return { url: url.replace(/\/+$/, ""), key };
}

async function uploadObject(path, buffer, contentType) {
  const { url, key } = requireConfig();
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${encodeURIComponent(path)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      "Content-Type": contentType || "application/octet-stream",
      "x-upsert": "false"
    },
    body: buffer
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase Storage upload failed (${res.status}): ${text.slice(0, 300)}`);
  }
}

async function downloadObject(path) {
  const { url, key } = requireConfig();
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${encodeURIComponent(path)}`, {
    headers: { Authorization: `Bearer ${key}`, apikey: key }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase Storage download failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function deleteObject(path) {
  const { url, key } = requireConfig();
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${encodeURIComponent(path)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${key}`, apikey: key }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase Storage delete failed (${res.status}): ${text.slice(0, 300)}`);
  }
}

module.exports = { uploadObject, downloadObject, deleteObject };
