/**
 * Custom Firebase Client Initialization & Real-Time Sync Engine
 * 
 * Initialized using environment variables (import.meta.env / process.env).
 * Fully decoupled from built-in project configurations.
 * 
 * Supports:
 * - Google Sign-In via popup (signInWithPopup)
 * - Real-time sync of accounts, ledger transactions, savings pools, categories & settings
 *   under Firestore path: users/{user.uid}
 */

import { initializeApp, getApps, deleteApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  onAuthStateChanged,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  getDocFromServer,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';

export interface FirebaseAppConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  measurementId?: string;
  firestoreDatabaseId?: string;
  [key: string]: unknown;
}

// Error handling contracts required by Firestore security specifications
export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

/**
 * Safely extract environment variable across Vite (import.meta.env) and Node/Webpack (process.env)
 */
function getEnvValue(keys: string[]): string {
  for (const key of keys) {
    try {
      // 1. Vite import.meta.env
      if (typeof import.meta !== 'undefined' && import.meta.env) {
        const val = import.meta.env[key];
        if (typeof val === 'string' && val.trim() !== '') {
          return val.trim();
        }
      }
    } catch {
      // ignore
    }

    try {
      // 2. Node / process.env
      if (typeof process !== 'undefined' && process.env) {
        const val = process.env[key];
        if (typeof val === 'string' && val.trim() !== '') {
          return val.trim();
        }
      }
    } catch {
      // ignore
    }
  }
  return '';
}

/**
 * Read custom configuration stored in localStorage (if set via the UI settings modal)
 */
function getStoredUserConfig(): Partial<FirebaseAppConfig> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem('ft_firebase_config_v1');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Partial<FirebaseAppConfig>;
      }
    }
  } catch (err) {
    console.warn('Could not read stored Firebase config from localStorage:', err);
  }
  return {};
}

/**
 * Resolves Firebase configuration prioritizing environment variables:
 * 1. import.meta.env / process.env
 * 2. localStorage override (ft_firebase_config_v1)
 */
export function resolveFirebaseConfig(): FirebaseAppConfig {
  const envConfig: FirebaseAppConfig = {
    apiKey: getEnvValue(['VITE_FIREBASE_API_KEY', 'FIREBASE_API_KEY', 'NEXT_PUBLIC_FIREBASE_API_KEY']),
    authDomain: getEnvValue(['VITE_FIREBASE_AUTH_DOMAIN', 'FIREBASE_AUTH_DOMAIN', 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN']),
    projectId: getEnvValue(['VITE_FIREBASE_PROJECT_ID', 'FIREBASE_PROJECT_ID', 'NEXT_PUBLIC_FIREBASE_PROJECT_ID']),
    storageBucket: getEnvValue(['VITE_FIREBASE_STORAGE_BUCKET', 'FIREBASE_STORAGE_BUCKET', 'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET']),
    messagingSenderId: getEnvValue(['VITE_FIREBASE_MESSAGING_SENDER_ID', 'FIREBASE_MESSAGING_SENDER_ID', 'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID']),
    appId: getEnvValue(['VITE_FIREBASE_APP_ID', 'FIREBASE_APP_ID', 'NEXT_PUBLIC_FIREBASE_APP_ID']),
    measurementId: getEnvValue(['VITE_FIREBASE_MEASUREMENT_ID', 'FIREBASE_MEASUREMENT_ID']),
    firestoreDatabaseId: getEnvValue(['VITE_FIREBASE_DATABASE_ID', 'VITE_FIREBASE_FIRESTORE_DATABASE_ID', 'FIREBASE_DATABASE_ID']),
  };

  const stored = getStoredUserConfig();

  // Combine: environment variables take precedence, falling back to stored config if env is empty
  const config: FirebaseAppConfig = {
    apiKey: envConfig.apiKey || stored.apiKey || '',
    authDomain: envConfig.authDomain || stored.authDomain || '',
    projectId: envConfig.projectId || stored.projectId || '',
    storageBucket: envConfig.storageBucket || stored.storageBucket || '',
    messagingSenderId: envConfig.messagingSenderId || stored.messagingSenderId || '',
    appId: envConfig.appId || stored.appId || '',
    measurementId: envConfig.measurementId || stored.measurementId || '',
    firestoreDatabaseId: envConfig.firestoreDatabaseId || stored.firestoreDatabaseId || '',
  };

  return config;
}

// Current singleton instances
export let app: FirebaseApp | null = null;
export let auth: Auth | null = null;
export let db: Firestore | null = null;
export let isConfigured = false;
export let currentConfig: FirebaseAppConfig = resolveFirebaseConfig();

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

/**
 * Standardized Firestore error handler adhering to security rules specification
 */
export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const currentUser = auth?.currentUser;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: currentUser?.uid ?? null,
      email: currentUser?.email ?? null,
      emailVerified: currentUser?.emailVerified ?? null,
      isAnonymous: currentUser?.isAnonymous ?? null,
      tenantId: currentUser?.tenantId ?? null,
      providerInfo:
        currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

/**
 * Initialize or re-initialize Firebase application with specified or detected configuration
 */
export function initFirebase(customConfig?: Partial<FirebaseAppConfig>): {
  app: FirebaseApp | null;
  auth: Auth | null;
  db: Firestore | null;
  isConfigured: boolean;
} {
  const baseConfig = resolveFirebaseConfig();
  const config: FirebaseAppConfig = {
    ...baseConfig,
    ...(customConfig || {}),
  };

  currentConfig = config;

  if (!config.apiKey || !config.projectId) {
    console.warn(
      '[Firebase] Custom Firebase configuration is missing apiKey or projectId. ' +
      'Please configure environment variables (e.g. VITE_FIREBASE_API_KEY, VITE_FIREBASE_PROJECT_ID) ' +
      'or configure them in the Cloud Sync modal.'
    );
    isConfigured = false;
    return { app: null, auth: null, db: null, isConfigured: false };
  }

  try {
    const existingApps = getApps();
    if (existingApps.length > 0) {
      app = existingApps[0];
    } else {
      app = initializeApp(config);
    }

    auth = getAuth(app);

    if (config.firestoreDatabaseId && config.firestoreDatabaseId !== '(default)') {
      db = getFirestore(app, config.firestoreDatabaseId);
    } else {
      db = getFirestore(app);
    }

    isConfigured = true;
    console.info(`[Firebase] Initialized custom Firebase app for project: "${config.projectId}"`);
  } catch (err) {
    console.error('[Firebase] Initialization error:', err);
    isConfigured = false;
  }

  return { app, auth, db, isConfigured };
}

// Initial auto-initialization attempt
try {
  initFirebase();
} catch (err) {
  console.warn('[Firebase] Initial auto-config deferred:', err);
}

export function getAuthSafe(): Auth {
  if (!auth) {
    initFirebase();
  }
  if (!auth) {
    throw new Error(
      'Firebase Auth is not initialized. Please ensure VITE_FIREBASE_API_KEY and VITE_FIREBASE_PROJECT_ID are set in your environment variables.'
    );
  }
  return auth;
}

export function getDbSafe(): Firestore {
  if (!db) {
    initFirebase();
  }
  if (!db) {
    throw new Error(
      'Firestore is not initialized. Please ensure VITE_FIREBASE_API_KEY and VITE_FIREBASE_PROJECT_ID are set in your environment variables.'
    );
  }
  return db;
}

/**
 * Diagnostic connection check
 */
export async function testConnection(): Promise<boolean> {
  if (!isConfigured) return false;
  try {
    const firestore = getDbSafe();
    await getDocFromServer(doc(firestore, 'test', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn('Firebase client is offline. Please check your network and configuration.');
    }
    return false;
  }
}

/**
 * Sign in using Google Auth Provider via Popup (with automatic fallback to redirect)
 */
export async function signInWithGoogle(): Promise<User> {
  const authInstance = getAuthSafe();
  try {
    const result = await signInWithPopup(authInstance, googleProvider);
    return result.user;
  } catch (err: unknown) {
    const error = err as { code?: string; message?: string };
    if (error.code === 'auth/popup-blocked') {
      try {
        await signInWithRedirect(authInstance, googleProvider);
        throw new Error('Redirecting to Google sign in...');
      } catch (redirectErr) {
        throw new Error('Sign-in popup was blocked by your browser. Please allow popups for this site.');
      }
    }
    if (error.code === 'auth/popup-closed-by-user') {
      throw new Error('Google Sign-In was cancelled.');
    }
    if (error.code === 'auth/unauthorized-domain') {
      const host = typeof window !== 'undefined' ? window.location.hostname : 'this domain';
      throw new Error(
        `Domain "${host}" is not authorized. In Firebase Console, go to Authentication -> Settings -> Authorized domains and add "${host}".`
      );
    }
    if (error.code === 'auth/operation-not-allowed') {
      throw new Error('Google Sign-In is not enabled. In Firebase Console, go to Authentication -> Sign-in method and enable Google.');
    }
    console.error('Google Sign-In failed:', error);
    throw new Error(error.message || 'Failed to sign in with Google');
  }
}

/**
 * Sign out current authenticated user
 */
export async function signOutUser(): Promise<void> {
  if (!auth) return;
  await signOut(auth);
}

/**
 * Subscribe to Auth State Changes
 */
export function onAuthUserChanged(callback: (user: User | null) => void): Unsubscribe {
  try {
    const authInstance = getAuthSafe();
    return onAuthStateChanged(authInstance, callback);
  } catch (err) {
    console.warn('[Firebase] Auth listener deferred until credentials configured:', err);
    callback(null);
    return () => {};
  }
}

/**
 * Subscribe to User's Firestore Cloud Ledger in Real-Time
 * Synchronizes all app data under users/{user.uid}
 */
export function subscribeToUserData(
  userId: string,
  onData: (data: Record<string, unknown> | null) => void,
  onError: (err: Error) => void
): Unsubscribe {
  try {
    const firestore = getDbSafe();
    const docPath = `users/${userId}/data/vault`;
    const userDocRef = doc(firestore, 'users', userId, 'data', 'vault');

    return onSnapshot(
      userDocRef,
      (snapshot) => {
        if (snapshot.exists()) {
          onData(snapshot.data() as Record<string, unknown>);
        } else {
          onData(null);
        }
      },
      (error) => {
        try {
          handleFirestoreError(error, OperationType.GET, docPath);
        } catch (handledError) {
          onError(handledError as Error);
        }
      }
    );
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
    return () => {};
  }
}

/**
 * Save / Push State to User's Firestore Cloud Ledger under users/{user.uid}
 * Writes to primary path users/{userId}/data/vault and syncs users/{userId}
 */
export async function saveUserData(userId: string, data: Record<string, unknown>): Promise<void> {
  const firestore = getDbSafe();
  const docPath = `users/${userId}/data/vault`;
  const userVaultRef = doc(firestore, 'users', userId, 'data', 'vault');
  const userDirectRef = doc(firestore, 'users', userId);

  try {
    const payload = {
      ...data,
      userId,
      updatedAt: new Date().toISOString(),
    };
    
    // Write primary subcollection record
    await setDoc(userVaultRef, payload, { merge: true });

    // Also mirror to users/{userId} for direct path parity
    try {
      await setDoc(userDirectRef, payload, { merge: true });
    } catch {
      // non-fatal if security rules strictly govern subcollection
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, docPath);
  }
}

/**
 * Fetch one-time snapshot of user's ledger data under users/{user.uid}
 */
export async function getUserData(userId: string): Promise<Record<string, unknown> | null> {
  const firestore = getDbSafe();
  const docPath = `users/${userId}/data/vault`;
  const userVaultRef = doc(firestore, 'users', userId, 'data', 'vault');
  const userDirectRef = doc(firestore, 'users', userId);

  try {
    const snap = await getDoc(userVaultRef);
    if (snap.exists()) {
      return snap.data() as Record<string, unknown>;
    }
    const directSnap = await getDoc(userDirectRef);
    return directSnap.exists() ? (directSnap.data() as Record<string, unknown>) : null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, docPath);
  }
}

// Expose on window.FirebaseEngine for seamless integration with index.html
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).FirebaseEngine = {
    get app() {
      return app;
    },
    get auth() {
      return auth;
    },
    get db() {
      return db;
    },
    get isConfigured() {
      return isConfigured;
    },
    get defaultFirebaseConfig() {
      return currentConfig;
    },
    initFirebase,
    signInWithGoogle,
    signOutUser,
    onAuthUserChanged,
    subscribeToUserData,
    saveUserData,
    getUserData,
    testConnection,
  };

  // Dispatch readiness signal
  window.dispatchEvent(new CustomEvent('firebase-engine-ready'));
}
