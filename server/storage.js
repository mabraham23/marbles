import { Redis } from "@upstash/redis";

// Initialize dotenv in case storage.js is imported first
import dotenv from "dotenv";
dotenv.config();

const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const ROOM_KEY_PREFIX = "room:";
const TTL_SECONDS = 24 * 60 * 60; // 24 hours

class RedisRoomStore {
  constructor(url, token) {
    this.client = new Redis({ url, token });
    console.log("RoomStore: Using Upstash Redis database persistence");
  }

  async get(code) {
    try {
      const data = await this.client.get(ROOM_KEY_PREFIX + code);
      if (!data) return null;
      // Upstash Redis SDK auto-parses JSON strings if they are objects,
      // but let's safely handle both string and object cases.
      return typeof data === "string" ? JSON.parse(data) : data;
    } catch (err) {
      console.error(`RoomStore error fetching room ${code}:`, err);
      return null;
    }
  }

  async set(code, room) {
    try {
      // Stripped sockets and connection sets/maps from room before saving
      const serializableRoom = { ...room };
      delete serializableRoom.socketsByName;
      delete serializableRoom.preJoinSockets;

      await this.client.set(
        ROOM_KEY_PREFIX + code,
        JSON.stringify(serializableRoom),
        { ex: TTL_SECONDS }
      );
    } catch (err) {
      console.error(`RoomStore error saving room ${code}:`, err);
    }
  }

  async delete(code) {
    try {
      await this.client.del(ROOM_KEY_PREFIX + code);
    } catch (err) {
      console.error(`RoomStore error deleting room ${code}:`, err);
    }
  }

  async list() {
    try {
      // Find all room keys
      const keys = await this.client.keys(ROOM_KEY_PREFIX + "*");
      const rooms = [];
      for (const key of keys) {
        const code = key.replace(ROOM_KEY_PREFIX, "");
        const room = await this.get(code);
        if (room) rooms.push(room);
      }
      return rooms;
    } catch (err) {
      console.error("RoomStore error listing rooms:", err);
      return [];
    }
  }
}

class MemoryRoomStore {
  constructor() {
    this.map = new Map();
    console.log("RoomStore: Using local in-memory fallback storage (no Redis URL detected)");
  }

  async get(code) {
    const data = this.map.get(code);
    if (!data) return null;
    // Deep clone to simulate database serialization boundaries
    return JSON.parse(JSON.stringify(data));
  }

  async set(code, room) {
    const serializableRoom = { ...room };
    delete serializableRoom.socketsByName;
    delete serializableRoom.preJoinSockets;

    // Deep clone to simulate database serialization boundaries
    this.map.set(code, JSON.parse(JSON.stringify(serializableRoom)));
  }

  async delete(code) {
    this.map.delete(code);
  }

  async list() {
    return Array.from(this.map.values()).map((r) => JSON.parse(JSON.stringify(r)));
  }
}

export const roomStore =
  URL && TOKEN
    ? new RedisRoomStore(URL, TOKEN)
    : new MemoryRoomStore();
