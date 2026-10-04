/**
 * FirebaseContext - Persistent Multi-Device Auth & Seafarer Profile Context
 * 
 * Configures onAuthStateChanged to persist user sessions and real-time seafarer credentials
 * across page reloads, browser restarts, and across devices.
 */

import React, { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { User } from 'firebase/auth';
import {
  auth,
  onAuthUserChanged,
  signInWithGoogle,
  signInWithEmail,
  signUpWithEmail,
  sendPasswordReset,
  signOutUser,
  saveSeafarerProfile,
  getSeafarerProfile,
  subscribeToSeafarerProfile,
  type SeafarerProfile,
  isConfigured,
} from './firebase';

export interface FirebaseContextValue {
  user: User | null;
  profile: SeafarerProfile | null;
  loading: boolean;
  isConfigured: boolean;
  hasProfile: boolean;
  signInWithGoogle: () => Promise<User>;
  signInWithEmail: (email: string, pass: string) => Promise<User>;
  signUpWithEmail: (email: string, pass: string, fullName?: string) => Promise<User>;
  sendPasswordReset: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  updateProfile: (profile: SeafarerProfile) => Promise<void>;
  refreshProfile: () => Promise<void>;
}

export const FirebaseContext = createContext<FirebaseContextValue | undefined>(undefined);

export interface FirebaseProviderProps {
  children: ReactNode;
}

export function FirebaseProvider({ children }: FirebaseProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<SeafarerProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    // Configures onAuthStateChanged to persist sessions across page reloads and devices
    const unsubscribeAuth = onAuthUserChanged(async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        try {
          const initialProfile = await getSeafarerProfile(currentUser.uid);
          setProfile(initialProfile);
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('seafarer-auth-changed', {
              detail: { user: currentUser, profile: initialProfile }
            }));
          }
        } catch (err) {
          console.error('Failed to load seafarer profile on auth change:', err);
        }
      } else {
        setProfile(null);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('seafarer-auth-changed', {
            detail: { user: null, profile: null }
          }));
        }
      }
      setLoading(false);
    });

    return () => {
      unsubscribeAuth();
    };
  }, []);

  // Real-time listener for the user's seafarer profile
  useEffect(() => {
    if (!user) {
      setProfile(null);
      return;
    }

    const unsubscribeProfile = subscribeToSeafarerProfile(
      user.uid,
      (updatedProfile) => {
        setProfile(updatedProfile);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('seafarer-profile-changed', {
            detail: { profile: updatedProfile }
          }));
        }
      },
      (err) => {
        console.warn('Profile listener notice:', err);
      }
    );

    return () => {
      unsubscribeProfile();
    };
  }, [user]);

  const handleUpdateProfile = async (newProfile: SeafarerProfile) => {
    if (!user) throw new Error('Cannot update profile: No authenticated user.');
    await saveSeafarerProfile(user.uid, newProfile);
    setProfile(newProfile);
  };

  const handleRefreshProfile = async () => {
    if (!user) return;
    const p = await getSeafarerProfile(user.uid);
    setProfile(p);
  };

  const hasProfile = Boolean(
    profile &&
    profile.fullName?.trim() &&
    profile.cdcNumber?.trim() &&
    profile.department &&
    profile.rank
  );

  const value: FirebaseContextValue = {
    user,
    profile,
    loading,
    isConfigured,
    hasProfile,
    signInWithGoogle,
    signInWithEmail,
    signUpWithEmail,
    sendPasswordReset,
    signOut: signOutUser,
    updateProfile: handleUpdateProfile,
    refreshProfile: handleRefreshProfile,
  };

  return <FirebaseContext.Provider value={value}>{children}</FirebaseContext.Provider>;
}

export function useFirebase(): FirebaseContextValue {
  const context = useContext(FirebaseContext);
  if (!context) {
    throw new Error('useFirebase must be used within a <FirebaseProvider>');
  }
  return context;
}

// Attach to window for seamless multi-framework or vanilla access
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).FirebaseContext = {
    FirebaseContext,
    FirebaseProvider,
    useFirebase,
  };
}
