/**
 * Fathirridha Finance Track - Firebase Authentication & Firestore Sync Engine
 * 
 * ============================================================================
 * FIREBASE CONFIGURATION SETUP INSTRUCTIONS:
 * ----------------------------------------------------------------------------
 * To configure or update your Firebase credentials:
 * 1. Go to Firebase Console (https://console.firebase.google.com).
 * 2. Select your Project -> Project Settings -> General -> Your apps -> Web app.
 * 3. Copy the firebaseConfig object and paste your credentials into /firebase-applet-config.json
 *    or update the fallback defaultFirebaseConfig object below:
 *    - apiKey: Web API Key (AIzaSy...)
 *    - authDomain: Authentication Domain (e.g., project-id.firebaseapp.com)
 *    - projectId: Firebase Project ID
 *    - storageBucket: Cloud Storage Bucket (e.g., project-id.firebasestorage.app)
 *    - messagingSenderId: Cloud Messaging Sender ID
 *    - appId: Web App ID (1:xxxx:web:xxxx)
 *    - firestoreDatabaseId: (Optional) Named Firestore Database ID
 * ============================================================================
 */

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
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

// Default configuration loaded from provisioned firebase-applet-config.json
import rawAppletConfig from '../firebase-applet-config.json';

export interface FirebaseAppConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  firestoreDatabaseId?: string;
  [key: string]: unknown;
}

export const defaultFirebaseConfig: FirebaseAppConfig = {
  apiKey: rawAppletConfig.apiKey || '',
  authDomain: rawAppletConfig.authDomain || '',
  projectId: rawAppletConfig.projectId || '',
  storageBucket: rawAppletConfig.storageBucket || '',
  messagingSenderId: rawAppletConfig.messagingSenderId || '',
  appId: rawAppletConfig.appId || '',
  firestoreDatabaseId: rawAppletConfig.firestoreDatabaseId || '',
};

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

// Global singletons
export let app: FirebaseApp | undefined;
export let auth: Auth | undefined;
export let db: Firestore | undefined;
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

/**
 * Initialize Firebase application instance
 */
export function initFirebase(customConfig?: Partial<FirebaseAppConfig>): { app: FirebaseApp; auth: Auth; db: Firestore } {
  const config = {
    ...defaultFirebaseConfig,
    ...(customConfig || {}),
  };

  const existingApps = getApps();
  if (existingApps.length > 0) {
    app = existingApps[0];
  } else {
    app = initializeApp(config);
  }

  auth = getAuth(app);

  // Initialize Firestore with specific database ID if configured
  if (config.firestoreDatabaseId) {
    db = getFirestore(app, config.firestoreDatabaseId);
  } else {
    db = getFirestore(app);
  }

  return { app, auth, db };
}

// Auto-initialize with default config on module load
try {
  initFirebase();
} catch (err) {
  console.warn('Firebase initialization warning:', err);
}

export function getAuthSafe(): Auth {
  if (!auth) initFirebase();
  if (!auth) throw new Error('Firebase Auth failed to initialize');
  return auth;
}

export function getDbSafe(): Firestore {
  if (!db) initFirebase();
  if (!db) throw new Error('Firestore database failed to initialize');
  return db;
}

/**
 * Test server connectivity as required by Firebase integration guidelines
 */
export async function testConnection(): Promise<boolean> {
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
 * Sign in using Google Auth Provider via Popup (with fallback to Redirect)
 */
export async function signInWithGoogle(): Promise<User> {
  const authInstance = getAuthSafe();
  try {
    const result = await signInWithPopup(authInstance, googleProvider);
    return result.user;
  } catch (err: unknown) {
    const error = err as { code?: string; message?: string };
    if (error.code === 'auth/popup-blocked' || error.code === 'auth/popup-closed-by-user') {
      try {
        await signInWithRedirect(authInstance, googleProvider);
        throw new Error('Redirecting to Google sign in...');
      } catch (redirectErr) {
        console.error('Google sign in redirect error:', redirectErr);
        throw redirectErr;
      }
    }
    console.error('Google sign in error:', error);
    throw new Error(error.message || 'Failed to sign in with Google');
  }
}

/**
 * Sign out current authenticated user
 */
export async function signOutUser(): Promise<void> {
  const authInstance = getAuthSafe();
  await signOut(authInstance);
}

/**
 * Subscribe to Auth State Changes
 */
export function onAuthUserChanged(callback: (user: User | null) => void): Unsubscribe {
  const authInstance = getAuthSafe();
  return onAuthStateChanged(authInstance, callback);
}

/**
 * Subscribe to User's Firestore Cloud Ledger in Real-Time
 * Path: users/{userId}/data/vault
 */
export function subscribeToUserData(
  userId: string,
  onData: (data: Record<string, unknown> | null) => void,
  onError: (err: Error) => void
): Unsubscribe {
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
}

/**
 * Save / Push State to User's Firestore Cloud Ledger
 * Path: users/{userId}/data/vault
 */
export async function saveUserData(userId: string, data: Record<string, unknown>): Promise<void> {
  const firestore = getDbSafe();
  const docPath = `users/${userId}/data/vault`;
  const userDocRef = doc(firestore, 'users', userId, 'data', 'vault');

  try {
    const payload = {
      ...data,
      userId,
      updatedAt: new Date().toISOString(),
    };
    await setDoc(userDocRef, payload, { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, docPath);
  }
}

/**
 * Fetch one-time snapshot of user's ledger data
 */
export async function getUserData(userId: string): Promise<Record<string, unknown> | null> {
  const firestore = getDbSafe();
  const docPath = `users/${userId}/data/vault`;
  const userDocRef = doc(firestore, 'users', userId, 'data', 'vault');

  try {
    const snap = await getDoc(userDocRef);
    return snap.exists() ? (snap.data() as Record<string, unknown>) : null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, docPath);
  }
}

// Expose on window for easy access by web app
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).FirebaseEngine = {
    get auth() {
      return auth;
    },
    get db() {
      return db;
    },
    defaultFirebaseConfig,
    signInWithGoogle,
    signOutUser,
    onAuthUserChanged,
    subscribeToUserData,
    saveUserData,
    getUserData,
    testConnection,
  };
}
