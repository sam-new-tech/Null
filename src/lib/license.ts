import { useEffect, useState, useSyncExternalStore } from 'react';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';

import { storeDel, storeGet, storeSet } from './storage';

const DEVICE_KEY = 'license.deviceId';
const KEY_KEY = 'license.key';
const BIND_KEY = 'license.binding';

const PEPPER = process.env.EXPO_PUBLIC_LICENSE_PEPPER ?? '';

function norm(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function randomId(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789abcdefghijklmnopqrstuvwxyz';
  let out = '';
  const buf = new Uint8Array(16);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  for (const b of buf) out += chars[b % chars.length];
  return out;
}

/** Stable per-install, per-device binding id. Reinstall = new id. */
export async function deviceId(): Promise<string> {
  const existing = await storeGet(DEVICE_KEY);
  if (existing) return existing;
  const id = `${Device.brand ?? 'dev'}-${Device.modelName ?? 'unknown'}-${randomId()}`;
  await storeSet(DEVICE_KEY, id);
  return id;
}

async function bindingFor(key: string, device: string): Promise<string | null> {
  if (!PEPPER) return null;
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `${norm(key)}|${device.trim()}|${PEPPER}`,
  );
}

/**
 * Single-key activation with first-use binding: the key locks to the first
 * device that activates it. Re-verified against the live device id on every
 * launch, so a shared key dies on any other phone.
 */
export async function activateLicense(key: string): Promise<void> {
  const cleanKey = norm(key);
  if (cleanKey.length < 16) throw new Error('That code looks too short');
  const device = await deviceId();
  const binding = await bindingFor(cleanKey, device);
  if (binding === null) throw new Error('App is missing its license pepper — reinstall from the seller');
  await storeSet(KEY_KEY, cleanKey);
  await storeSet(BIND_KEY, binding);
  emitLicensed(true);
}

export async function isLicensed(): Promise<boolean> {
  const [key, binding] = await Promise.all([storeGet(KEY_KEY), storeGet(BIND_KEY)]);
  if (!key || !binding) return false;
  const device = await deviceId();
  const expected = await bindingFor(key, device);
  return expected !== null && expected === binding;
}

export async function deactivateLicense(): Promise<void> {
  await storeDel(KEY_KEY);
  await storeDel(BIND_KEY);
  emitLicensed(false);
}

// Shared reactive licensed flag: activation must wake the root guard in the
// same tick — a hook-local useState never leaves its own component.
let licensedCache: boolean | null = null;
const licenseListeners = new Set<() => void>();

function emitLicensed(value: boolean): void {
  licensedCache = value;
  licenseListeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // Ignore — a bad subscriber must not break activation.
    }
  });
}

function subscribeLicense(listener: () => void): () => void {
  licenseListeners.add(listener);
  return () => {
    licenseListeners.delete(listener);
  };
}

function getLicensedSnapshot(): boolean {
  return licensedCache ?? false;
}

export function useLicense(): { licensed: boolean; hydrated: boolean } {
  const licensed = useSyncExternalStore(subscribeLicense, getLicensedSnapshot);
  const [hydrated, setHydrated] = useState(licensedCache !== null);
  useEffect(() => {
    let live = true;
    isLicensed()
      .then((ok) => {
        if (live) {
          emitLicensed(ok);
          setHydrated(true);
        }
      })
      .catch(() => {
        if (live) {
          emitLicensed(false);
          setHydrated(true);
        }
      });
    return () => {
      live = false;
    };
  }, []);
  return { licensed, hydrated };
}
