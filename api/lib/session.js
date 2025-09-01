// api/lib/session.js
import { redis } from "./redis.js";
import crypto from "crypto";

export function newSid() {
  return crypto.randomBytes(32).toString("base64url");
}

export async function createSession(userId, data, ttlSec) {
  const sid = newSid();
  const key = `sess:${sid}`;
  await redis.multi()
    .set(key, JSON.stringify({ userId, ...data }))
    .expire(key, ttlSec)
    .sadd(`user:sessions:${userId}`, sid)
    .exec();
  return sid;
}

export async function readSession(sid) {
  const raw = await redis.get(`sess:${sid}`);
  return raw ? JSON.parse(raw) : null;
}

export async function rotateSession(oldSid, userId, data, ttlSec) {
  const newId = newSid();
  const pipe = redis.multi();
  pipe.del(`sess:${oldSid}`);
  pipe.srem(`user:sessions:${userId}`, oldSid);
  pipe.set(`sess:${newId}`, JSON.stringify({ userId, ...data }));
  pipe.expire(`sess:${newId}`, ttlSec);
  pipe.sadd(`user:sessions:${userId}`, newId);
  await pipe.exec();
  return newId;
}

export async function deleteSession(sid, userId) {
  await redis.multi()
    .del(`sess:${sid}`)
    .srem(`user:sessions:${userId}`, sid)
    .exec();
}

export async function deleteAllSessions(userId) {
  const key = `user:sessions:${userId}`;
  const sids = await redis.smembers(key);
  const pipe = redis.multi();
  sids.forEach((sid) => pipe.del(`sess:${sid}`));
  pipe.del(key);
  await pipe.exec();
}
